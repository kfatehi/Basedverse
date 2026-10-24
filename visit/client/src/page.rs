//! The page side (../SPEC.md sections 3, 4.3 and 5): HTTP on 127.0.0.1 only. `/visit.js` (the library,
//! built into this binary) and `/health` are public; `/ws` is the page connection, which must give the
//! token in its first message. Ten wrong tokens in a minute shut the door for a minute.
use std::{
    collections::VecDeque,
    sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    extract::{
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::header,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::{net::TcpListener, sync::mpsc};
use tracing::{info, warn};

use crate::{
    core::{Ev, PageOut},
    ct_eq, VERSION,
};

pub const PROTO: &str = "basedverse-visit-local/1";
const LIBRARY: &str = include_str!("../web/visit.js");

pub struct PageState {
    pub token: String,
    pub core: mpsc::UnboundedSender<Ev>,
    next_id: AtomicU64,
    failures: Mutex<VecDeque<Instant>>,
}

impl PageState {
    pub fn new(token: String, core: mpsc::UnboundedSender<Ev>) -> Arc<PageState> {
        Arc::new(PageState { token, core, next_id: AtomicU64::new(1), failures: Mutex::default() })
    }

    fn failures_in_the_last_minute(&self) -> usize {
        let mut f = self.failures.lock().unwrap();
        while f.front().is_some_and(|t| t.elapsed() > Duration::from_secs(60)) {
            f.pop_front();
        }
        f.len()
    }
}

pub async fn serve(listener: TcpListener, state: Arc<PageState>) -> std::io::Result<()> {
    let app = Router::new()
        .route("/visit.js", get(library))
        .route("/health", get(|| async { Json(json!({ "ok": true, "version": VERSION })) }))
        .route("/ws", get(upgrade))
        .with_state(state);
    axum::serve(listener, app).await
}

async fn library() -> Response {
    ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8"), (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"), (header::CACHE_CONTROL, "no-store")], LIBRARY)
        .into_response()
}

async fn upgrade(ws: WebSocketUpgrade, State(st): State<Arc<PageState>>) -> Response {
    ws.max_message_size(2 << 20).on_upgrade(move |sock| page(sock, st))
}

async fn close(sock: &mut WebSocket, code: u16, why: &'static str) {
    let _ = sock.send(Message::Close(Some(CloseFrame { code, reason: why.into() }))).await;
}

async fn page(mut sock: WebSocket, st: Arc<PageState>) {
    if st.failures_in_the_last_minute() >= 10 {
        return close(&mut sock, 4429, "too many wrong tokens").await;
    }
    let hello = match tokio::time::timeout(Duration::from_secs(5), sock.recv()).await {
        Ok(Some(Ok(Message::Text(t)))) => serde_json::from_str::<Value>(t.as_str()).unwrap_or(Value::Null),
        _ => Value::Null,
    };
    if hello.get("type").and_then(Value::as_str) != Some("hello") || hello.get("proto").and_then(Value::as_str) != Some(PROTO) {
        return close(&mut sock, 4400, "say hello, basedverse-visit-local/1").await;
    }
    if !ct_eq(hello.get("token").and_then(Value::as_str).unwrap_or(""), &st.token) {
        st.failures.lock().unwrap().push_back(Instant::now());
        warn!("a page gave a wrong token");
        return close(&mut sock, 4401, "wrong token").await;
    }
    let id = st.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, mut rx) = mpsc::channel::<PageOut>(1024);
    if st.core.send(Ev::PageOpen { id, tx }).is_err() {
        return;
    }
    let sim = hello.get("sim").cloned().unwrap_or(Value::Null);
    info!(id, %sim, "page connected");
    let (mut sink, mut stream) = sock.split();
    let writer = tokio::spawn(async move {
        while let Some(out) = rx.recv().await {
            let sent = match out {
                PageOut::Text(s) => sink.send(Message::Text(s.into())).await,
                PageOut::Binary(b) => {
                    tracing::trace!(len = b.len(), "binary to the page");
                    sink.send(Message::Binary(b)).await
                }
                PageOut::Close(code, why) => {
                    let _ = sink.send(Message::Close(Some(CloseFrame { code, reason: why.into() }))).await;
                    return;
                }
            };
            if sent.is_err() {
                return;
            }
        }
    });
    while let Some(Ok(m)) = stream.next().await {
        let ev = match m {
            Message::Text(t) => Ev::PageMsg { id, msg: serde_json::from_str(t.as_str()).unwrap_or(Value::Null) },
            Message::Binary(b) => Ev::PageBin { id, data: b },
            Message::Close(_) => break,
            _ => continue,
        };
        if st.core.send(ev).is_err() {
            break;
        }
    }
    let _ = st.core.send(Ev::PageClosed { id });
    info!(id, "page gone");
    writer.abort();
}
