//! The lobby session (../SPEC.md section 6): one WebSocket to the lobby, `basedverse-lobby/3`. It
//! reconnects by itself (1 s, 2 s, 4 s, ... up to 30 s) and resumes its session with the secret from the
//! last welcome, so a drop shorter than the lobby's resume window keeps the office, its knocks and its
//! visits. Everything the lobby says goes to the core; the core's messages go to the lobby. The lobby pings
//! every 20 s: a connection silent for a minute (a laptop waking, a network gone) is given up and made
//! again. Away (the page left the lobby on purpose), it says bye and stays out until it is asked back.
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::{sync::mpsc, time::Instant};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn};

use crate::core::Ev;

pub const PROTO: &str = "basedverse-lobby/3";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const SILENCE: Duration = Duration::from_secs(60);

/// What the core asks of the lobby session.
pub enum LobbyOut {
    /// A message for the lobby.
    Msg(Value),
    /// Leave the lobby and stay out (away), until `Join`.
    Leave,
    /// Come back after `Leave`: a new session.
    Join,
    /// Leave for good (the visit-client is stopping).
    Bye,
}

/// How this office introduces itself; kept current (its status, its visitors, its name as the lobby last
/// showed it), so a new session starts as the office now is.
pub struct Hello {
    pub name: String,
    pub sim: Value,
    pub status: String,
    pub max_visitors: u8,
}

/// Until `Bye`. `away`: start out of the lobby (as the page last left it), until `Join`.
pub async fn run(url: String, mut hello: Hello, mut out: mpsc::UnboundedReceiver<LobbyOut>, core: mpsc::UnboundedSender<Ev>, mut away: bool) {
    let (mut resume, mut backoff, mut me) = (None::<String>, 1u64, None::<String>);
    loop {
        if away {
            info!("away: out of the lobby until the page asks to come back");
            loop {
                match out.recv().await {
                    Some(LobbyOut::Join) => break,
                    Some(LobbyOut::Bye) | None => return,
                    Some(_) => {}   // nothing to send while away
                }
            }
            (away, resume, backoff) = (false, None, 1);
        }
        match tokio::time::timeout(CONNECT_TIMEOUT, connect_async(url.as_str())).await {
            Ok(Ok((ws, _))) => {
                let (mut tx, mut rx) = ws.split();
                // `world`: this visit-client takes knocks to watch (../WORLD.md), so others may make them; `links`:
                // a knock it is let in on may start a link (a watch its page shows in a corner, 8.5).
                let mut first = json!({ "type": "hello", "proto": PROTO, "name": hello.name, "sim": hello.sim,
                                        "status": hello.status, "max_visitors": hello.max_visitors, "world": true, "links": true, "chat": true });
                if let Some(r) = &resume {
                    first["resume"] = json!(r);
                }
                if tx.send(Message::Text(first.to_string().into())).await.is_ok() {
                    let (mut welcomed, mut heard) = (false, Instant::now());
                    loop {
                        tokio::select! {
                            m = rx.next() => {
                                heard = Instant::now();   // pings count: tungstenite answers them as it reads
                                match m {
                                    Some(Ok(Message::Text(t))) => {
                                        let Ok(v) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                                        let kind = v.get("type").and_then(Value::as_str).unwrap_or("").to_string();
                                        if kind == "welcome" {
                                            resume = v.get("resume").and_then(Value::as_str).map(str::to_string);
                                            me = v.get("id").and_then(Value::as_str).map(str::to_string);
                                            welcomed = true;
                                            backoff = 1;
                                        } else if kind == "lobby" {   // its name as the lobby shows it (after a rename)
                                            let mine = v.get("offices").and_then(Value::as_array).into_iter().flatten()
                                                .find(|o| o.get("id").and_then(Value::as_str) == me.as_deref());
                                            if let Some(name) = mine.and_then(|o| o.get("name")).and_then(Value::as_str) {
                                                hello.name = name.to_string();
                                            }
                                        }
                                        let refused = !welcomed && kind == "error";
                                        let code = v.get("code").and_then(Value::as_str).unwrap_or("").to_string();
                                        let _ = core.send(Ev::Lobby(v));   // a refusal too: the page says why
                                        if refused {
                                            warn!(code, "the lobby refused this office");
                                            if code == "name_invalid" || code == "proto_unsupported" {
                                                let _ = core.send(Ev::Fatal(4));
                                                return;
                                            }
                                            break;   // name_taken: its old session may still be held; try again later
                                        }
                                    }
                                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                                    Some(Ok(_)) => {}
                                }
                            }
                            _ = tokio::time::sleep_until(heard + SILENCE) => {
                                warn!("the lobby has been silent for a minute: connecting again");
                                break;
                            }
                            o = out.recv() => match o {
                                Some(LobbyOut::Msg(m)) => {
                                    match m.get("type").and_then(Value::as_str) {
                                        Some("status") => if let Some(s) = m.get("status").and_then(Value::as_str) { hello.status = s.to_string() },
                                        Some("max_visitors") => if let Some(n) = m.get("n").and_then(Value::as_u64) { hello.max_visitors = n.min(8) as u8 },
                                        _ => {}
                                    }
                                    if tx.send(Message::Text(m.to_string().into())).await.is_err() { break }
                                }
                                Some(LobbyOut::Leave) => {   // the session ends at once: nothing to resume
                                    let _ = tx.send(Message::Text(json!({ "type": "bye" }).to_string().into())).await;
                                    let _ = tx.close().await;
                                    away = true;
                                    break;
                                }
                                Some(LobbyOut::Join) => {}
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
                if away {
                    continue;
                }
            }
            Ok(Err(e)) => warn!("cannot reach the lobby: {e}"),
            Err(_) => warn!("the lobby did not answer in {} s", CONNECT_TIMEOUT.as_secs()),
        }
        info!("connecting to the lobby again in {backoff} s");
        // Waiting to try again; asked to leave meanwhile, it stays out instead.
        let wait = tokio::time::sleep(Duration::from_secs(backoff));
        tokio::pin!(wait);
        loop {
            tokio::select! {
                _ = &mut wait => break,
                o = out.recv() => match o {
                    Some(LobbyOut::Leave) => { away = true; break }
                    Some(LobbyOut::Bye) | None => return,
                    Some(_) => {}
                },
            }
        }
        backoff = (backoff * 2).clamp(1, 30);
    }
}
