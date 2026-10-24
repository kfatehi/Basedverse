//! The lobby session (../SPEC.md section 6): one WebSocket to the lobby, `basedverse-lobby/2`. It
//! reconnects by itself (1 s, 2 s, 4 s, ... up to 30 s) and resumes its session with the secret from the
//! last welcome, so a drop shorter than the lobby's resume window keeps the office, its knocks and its
//! visits. Everything the lobby says goes to the core; the core's messages go to the lobby.
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn};

use crate::core::Ev;

pub const PROTO: &str = "basedverse-lobby/2";

/// What the core asks of the lobby session.
pub enum LobbyOut {
    /// A message for the lobby.
    Msg(Value),
    /// Leave, and come back under another name (a new session).
    Rename(String),
    /// Leave for good (the visit-client is stopping).
    Bye,
}

/// How this office introduces itself; kept current, so a new session starts as the office now is.
pub struct Hello {
    pub name: String,
    pub sim: Value,
    pub status: String,
    pub max_visitors: u8,
}

pub async fn run(url: String, mut hello: Hello, mut out: mpsc::UnboundedReceiver<LobbyOut>, core: mpsc::UnboundedSender<Ev>) {
    let (mut resume, mut backoff) = (None::<String>, 1u64);
    loop {
        match connect_async(url.as_str()).await {
            Ok((ws, _)) => {
                let (mut tx, mut rx) = ws.split();
                let mut first = json!({ "type": "hello", "proto": PROTO, "name": hello.name, "sim": hello.sim,
                                        "status": hello.status, "max_visitors": hello.max_visitors });
                if let Some(r) = &resume {
                    first["resume"] = json!(r);
                }
                if tx.send(Message::Text(first.to_string().into())).await.is_ok() {
                    let mut welcomed = false;
                    loop {
                        tokio::select! {
                            m = rx.next() => match m {
                                Some(Ok(Message::Text(t))) => {
                                    let Ok(v) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                                    match v.get("type").and_then(Value::as_str) {
                                        Some("welcome") => {
                                            resume = v.get("resume").and_then(Value::as_str).map(str::to_string);
                                            welcomed = true;
                                            backoff = 1;
                                        }
                                        Some("error") if !welcomed => {
                                            let code = v.get("code").and_then(Value::as_str).unwrap_or("");
                                            let why = v.get("message").and_then(Value::as_str).unwrap_or("");
                                            warn!(code, "the lobby refused this office: {why}");
                                            if code == "name_invalid" || code == "proto_unsupported" {
                                                let _ = core.send(Ev::Fatal(4));
                                                return;
                                            }
                                            break;   // name_taken: its old session may still be held; try again later
                                        }
                                        _ => {}
                                    }
                                    let _ = core.send(Ev::Lobby(v));
                                }
                                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                                Some(Ok(_)) => {}
                            },
                            o = out.recv() => match o {
                                Some(LobbyOut::Msg(m)) => {
                                    match m.get("type").and_then(Value::as_str) {
                                        Some("status") => if let Some(s) = m.get("status").and_then(Value::as_str) { hello.status = s.to_string() },
                                        Some("max_visitors") => if let Some(n) = m.get("n").and_then(Value::as_u64) { hello.max_visitors = n.min(8) as u8 },
                                        _ => {}
                                    }
                                    if tx.send(Message::Text(m.to_string().into())).await.is_err() { break }
                                }
                                Some(LobbyOut::Rename(name)) => {
                                    info!(%name, "renaming: leaving to come back as a new office");
                                    let _ = tx.send(Message::Text(json!({ "type": "bye" }).to_string().into())).await;
                                    hello.name = name;
                                    resume = None;
                                    backoff = 0;
                                    break;
                                }
                                Some(LobbyOut::Bye) | None => {
                                    let _ = tx.send(Message::Text(json!({ "type": "bye" }).to_string().into())).await;
                                    let _ = tx.close().await;
                                    return;
                                }
                            },
                        }
                    }
                }
                let _ = core.send(Ev::LobbyDown);
            }
            Err(e) => warn!("cannot reach the lobby: {e}"),
        }
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).clamp(1, 30);
    }
}
