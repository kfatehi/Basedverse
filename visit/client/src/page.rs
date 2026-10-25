//! The page side (../SPEC.md sections 3, 4.3 and 5): HTTP on 127.0.0.1 only. `/visit.js` (the library,
//! built into this binary) and `/health` are public; `/ws` is the page connection, which must give the
//! token in its first message, and, when `--origins` names the sim's own, come from one of them.
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use axum::{
    extract::{
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    serve::ListenerExt,
    Json, Router,
};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::{net::TcpListener, sync::mpsc};
use tracing::{info, warn};

use crate::{
    core::{Ev, PageOut},
    ct_eq, VERSION,
};

pub const PROTO: &str = "basedverse-visit-local/1";
/// How many frames may wait for a page. Messages have a queue of their own, never dropped: a page that
/// falls behind loses frames (and then waits for a keyframe), never what it is told.
pub const FRAME_QUEUE: usize = 256;
const LIBRARY: &str = include_str!("../web/visit.js");

pub struct PageState {
    pub token: String,
    /// The pages' origins allowed to connect (`--origins`); empty: any, the token alone deciding.
    pub origins: Vec<String>,
    pub core: mpsc::UnboundedSender<Ev>,
    next_id: AtomicU64,
}

impl PageState {
    pub fn new(token: String, origins: Vec<String>, core: mpsc::UnboundedSender<Ev>) -> Arc<PageState> {
        Arc::new(PageState { token, origins, core, next_id: AtomicU64::new(1) })
    }
}

pub async fn serve(listener: TcpListener, state: Arc<PageState>) -> std::io::Result<()> {
    // Nagle's algorithm off: a small message (an input, a frame's tail) goes now, not after the last one's
    // acknowledgement (which itself may wait 40 ms). Browsers turn it off on their side too.
    let listener = listener.tap_io(|s| {
        let _ = s.set_nodelay(true);
    });
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

async fn upgrade(ws: WebSocketUpgrade, headers: HeaderMap, State(st): State<Arc<PageState>>) -> Response {
    // A browser always says which page opens a WebSocket, and a page cannot change it: a token stolen
    // somehow is no use to another site's page.
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()).unwrap_or("");
    if !st.origins.is_empty() && !st.origins.iter().any(|o| o == origin) {
        warn!(origin, "a page from an origin not in --origins");
        return (StatusCode::FORBIDDEN, "not from this workroom's page").into_response();
    }
    ws.max_message_size(crate::frames::MAX_SCENE + 64).max_frame_size(crate::frames::MAX_SCENE + 64).on_upgrade(move |sock| page(sock, st))
}

async fn close(sock: &mut WebSocket, code: u16, why: &'static str) {
    let _ = sock.send(Message::Close(Some(CloseFrame { code, reason: why.into() }))).await;
}

async fn page(mut sock: WebSocket, st: Arc<PageState>) {
    let hello = match tokio::time::timeout(Duration::from_secs(5), sock.recv()).await {
        Ok(Some(Ok(Message::Text(t)))) => serde_json::from_str::<Value>(t.as_str()).unwrap_or(Value::Null),
        _ => Value::Null,
    };
    if hello.get("type").and_then(Value::as_str) != Some("hello") || hello.get("proto").and_then(Value::as_str) != Some(PROTO) {
        return close(&mut sock, 4400, "say hello, basedverse-visit-local/1").await;
    }
    if !ct_eq(hello.get("token").and_then(Value::as_str).unwrap_or(""), &st.token) {
        warn!("a page gave a wrong token");
        tokio::time::sleep(Duration::from_millis(250)).await;   // guessing is hopeless anyway (256 bits); slower still
        return close(&mut sock, 4401, "wrong token").await;
    }
    let id = st.next_id.fetch_add(1, Ordering::SeqCst);
    let (text_tx, mut text_rx) = mpsc::unbounded_channel::<PageOut>();
    let (frames_tx, mut frames_rx) = mpsc::channel::<Bytes>(FRAME_QUEUE);
    if st.core.send(Ev::PageOpen { id, text: text_tx, frames: frames_tx }).is_err() {
        return;
    }
    let sim = hello.get("sim").cloned().unwrap_or(Value::Null);
    info!(id, %sim, "page connected");
    let (mut sink, mut stream) = sock.split();
    let writer = tokio::spawn(async move {
        loop {
            let sent = tokio::select! {
                biased;   // what the page is told goes before the next frame
                out = text_rx.recv() => match out {
                    Some(PageOut::Text(s)) => sink.send(Message::Text(s.into())).await,
                    Some(PageOut::Close(code, why)) => {
                        let _ = sink.send(Message::Close(Some(CloseFrame { code, reason: why.into() }))).await;
                        return;
                    }
                    None => return,
                },
                f = frames_rx.recv() => match f {
                    Some(b) => sink.send(Message::Binary(b)).await,
                    None => return,
                },
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
