//! The links between visit-clients (../SPEC.md section 7): one QUIC connection per visit, made with iroh.
//! The visitor dials and proves the visit with its ticket; the host admits it only if the ticket matches
//! and the dialler is the endpoint the lobby named. A link that drops is redialled for a grace period.
//! Inputs travel as datagrams, video as one stream per group of pictures, everything else on the control
//! stream. Video is newest-wins, as in cloud gaming: a link that falls behind drops frames (and starts again
//! from a keyframe) rather than queue them, and a newer group of pictures cuts off the older's rest.
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use anyhow::{anyhow, bail, Result};
use bytes::Bytes;
use iroh::{
    endpoint::{presets, Connection, ConnectionError, Incoming, QuicTransportConfig, RecvStream, SendStream, VarInt},
    Endpoint, EndpointAddr, EndpointId, RelayMode, Watcher,
};
use serde_json::{json, Value};
use tokio::{sync::mpsc, task::JoinHandle, time::Instant};
use tracing::{debug, info, trace, warn};

use crate::{
    core::Ev,
    ct_eq,
    frames::{self, Frame},
};

pub const ALPN: &[u8] = b"basedverse-visit/1";
const DIAL_TIMEOUT: Duration = Duration::from_secs(20);
const GRACE: Duration = Duration::from_secs(15);
const REDIAL: Duration = Duration::from_secs(2);
const HANDSHAKE: Duration = Duration::from_secs(5);
/// The most a link may have sent and not yet had acknowledged, queued data included: a quarter of a second
/// of video at the highest bitrate, so a slow path backs the writer up (which then drops frames) instead of
/// buffering seconds of them (QUIC's default is 10 MB).
const SEND_WINDOW: u64 = 256 * 1024;
/// A frame this much older than the newest one waiting behind it is stale: the link is behind (microseconds,
/// of the frames' own timestamps). A few frames handed over at once, as an encoder does, are not.
const BEHIND_US: u64 = 100_000;

/// What the core tells one visit's link.
pub enum LinkCmd {
    /// A control message for the other side.
    Ctl(Value),
    /// The visitor's input (sent as a datagram).
    Input(Value),
    /// An encoded frame of the host's view.
    Frame(Frame),
    /// End the link, saying why.
    Close(String),
}

/// Which relays the endpoint uses: the lobby's (or iroh's own if it names none), or none at all.
pub enum Relays {
    Default,
    Off,
    Custom(Vec<String>),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    Host,
    Visitor,
}

/// A link that has passed its handshake.
pub struct Established {
    conn: Connection,
    send: SendStream,
    recv: RecvStream,
    /// The other side reads frames' meta (its handshake said `frame_meta`; visit-client 0.3 and later).
    meta: bool,
}

/// A visit a host is waiting to be dialled for.
struct Expected {
    ticket: String,
    endpoint: EndpointId,
    tx: mpsc::Sender<Established>,
}

type Ledger = Arc<Mutex<HashMap<String, Expected>>>;

/// This visit-client's endpoint, and the visits it expects to be dialled for.
#[derive(Clone)]
pub struct Links {
    ep: Endpoint,
    expected: Ledger,
    core: mpsc::UnboundedSender<Ev>,
}

impl Links {
    /// Binds the endpoint, starts admitting dialled links, and reports its address (and every change of
    /// it) to the core, to publish to the lobby.
    pub async fn start(relays: Relays, core: mpsc::UnboundedSender<Ev>) -> Result<Links> {
        let relay_mode = match relays {
            Relays::Default => RelayMode::Default,
            Relays::Off => RelayMode::Disabled,
            Relays::Custom(urls) => RelayMode::custom(
                urls.iter().map(|u| u.parse().map_err(|e| anyhow!("relay {u}: {e}"))).collect::<Result<Vec<_>>>()?,
            ),
        };
        let transport = QuicTransportConfig::builder().send_window(SEND_WINDOW).build();
        let ep = Endpoint::builder(presets::Minimal).alpns(vec![ALPN.to_vec()]).relay_mode(relay_mode).transport_config(transport).bind().await?;
        info!(endpoint = %ep.id(), "link endpoint up");
        let expected: Ledger = Arc::default();
        tokio::spawn(accept_loop(ep.clone(), expected.clone()));
        let (mut watch, id, tell) = (ep.watch_addr(), ep.id().to_string(), core.clone());
        tokio::spawn(async move {
            loop {
                let addr = watch.get();
                let _ = tell.send(Ev::LinkAddr { endpoint: id.clone(), addr: serde_json::to_value(&addr).unwrap_or(Value::Null) });
                if watch.updated().await.is_err() {
                    return;
                }
            }
        });
        Ok(Links { ep, expected, core })
    }

    /// The link for a visit to another office: dials it (`peer` is its `peer_link`).
    pub fn visitor(&self, visit: &str, ticket: &str, peer: &Value) -> Result<mpsc::Sender<LinkCmd>> {
        let addr: EndpointAddr = serde_json::from_value(peer.get("addr").cloned().unwrap_or_default())?;
        if peer.get("endpoint").and_then(Value::as_str) != Some(addr.id.to_string().as_str()) {
            bail!("the peer's endpoint and address disagree");
        }
        let (tx, rx) = mpsc::channel(256);
        tokio::spawn(visitor_task(self.ep.clone(), visit.to_string(), ticket.to_string(), addr, rx, self.core.clone()));
        Ok(tx)
    }

    /// The link for a visit to this office: waits to be dialled by the visitor named in `peer`.
    pub fn host(&self, visit: &str, ticket: &str, peer: &Value) -> Result<mpsc::Sender<LinkCmd>> {
        let endpoint: EndpointId = peer.get("endpoint").and_then(Value::as_str).ok_or_else(|| anyhow!("no endpoint"))?.parse()?;
        let (arrive_tx, arrive_rx) = mpsc::channel(2);
        self.expected.lock().unwrap().insert(visit.to_string(), Expected { ticket: ticket.to_string(), endpoint, tx: arrive_tx });
        let (tx, rx) = mpsc::channel(256);
        tokio::spawn(host_task(visit.to_string(), arrive_rx, rx, self.core.clone()));
        Ok(tx)
    }

    /// A visit is over: no more dialling for it is admitted.
    pub fn forget(&self, visit: &str) {
        self.expected.lock().unwrap().remove(visit);
    }

    pub async fn close(&self) {
        self.ep.close().await;
    }
}

async fn accept_loop(ep: Endpoint, expected: Ledger) {
    while let Some(incoming) = ep.accept().await {
        let expected = expected.clone();
        tokio::spawn(async move {
            if let Err(e) = admit(incoming, expected).await {
                debug!("refused a link: {e:#}");
            }
        });
    }
}

/// A dialled link: its first message must name a visit this office expects, with that visit's ticket,
/// from the endpoint the lobby named. Anything else is closed before another byte is read.
async fn admit(incoming: Incoming, expected: Ledger) -> Result<()> {
    let conn = incoming.accept()?.await?;
    let (mut send, mut recv) = tokio::time::timeout(HANDSHAKE, conn.accept_bi()).await??;
    let hello = tokio::time::timeout(HANDSHAKE, frames::read_msg(&mut recv)).await??.ok_or_else(|| anyhow!("no handshake"))?;
    let visit = hello.get("visit").and_then(Value::as_str).unwrap_or_default().to_string();
    let tx = {
        let ledger = expected.lock().unwrap();
        match ledger.get(&visit) {
            Some(x)
                if hello.get("proto").and_then(Value::as_str) == Some("basedverse-visit/1")
                    && ct_eq(hello.get("ticket").and_then(Value::as_str).unwrap_or(""), &x.ticket)
                    && conn.remote_id() == x.endpoint =>
            {
                x.tx.clone()
            }
            _ => {
                conn.close(VarInt::from_u32(1), b"refused");
                bail!("visit {visit:?}: wrong visit, ticket or endpoint");
            }
        }
    };
    frames::write_msg(&mut send, &json!({ "ok": true })).await?;
    let meta = hello.get("frame_meta").and_then(Value::as_bool).unwrap_or(false);
    tx.send(Established { conn, send, recv, meta }).await.map_err(|_| anyhow!("visit {visit} is over"))
}

/// The host turned the link down (code 1): its visit, ticket or endpoint did not match. Redialling is no use.
#[derive(Debug)]
struct Refused;

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the host refused the link (its visit, ticket or endpoint did not match)")
    }
}

impl std::error::Error for Refused {}

async fn dial(ep: &Endpoint, addr: &EndpointAddr, visit: &str, ticket: &str) -> Result<Established> {
    let conn = ep.connect(addr.clone(), ALPN).await?;
    let (mut send, mut recv) = conn.open_bi().await?;
    frames::write_msg(&mut send, &json!({ "proto": "basedverse-visit/1", "visit": visit, "ticket": ticket, "frame_meta": true })).await?;
    let ok = tokio::time::timeout(HANDSHAKE, frames::read_msg(&mut recv)).await.ok().and_then(Result::ok).flatten();
    if ok.as_ref().and_then(|v| v.get("ok")).and_then(Value::as_bool) != Some(true) {
        if matches!(conn.close_reason(), Some(ConnectionError::ApplicationClosed(c)) if c.error_code.into_inner() == 1) {
            return Err(Refused.into());
        }
        bail!("the host did not answer the handshake");
    }
    Ok(Established { conn, send, recv, meta: false })   // the host sends the video: whether it reads meta is moot
}

/// Waits for a Close from the core (or for the core to drop the link), discarding anything else: what is
/// sent while there is no connection is not kept (the core resends what matters when the link is back).
async fn closed_by_core(cmds: &mut mpsc::Receiver<LinkCmd>) {
    while let Some(cmd) = cmds.recv().await {
        if let LinkCmd::Close(_) = cmd {
            return;
        }
    }
}

async fn visitor_task(ep: Endpoint, visit: String, ticket: String, addr: EndpointAddr, mut cmds: mpsc::Receiver<LinkCmd>, core: mpsc::UnboundedSender<Ev>) {
    let (mut deadline, mut first) = (Instant::now() + DIAL_TIMEOUT, true);
    loop {
        let dialled = tokio::select! {
            r = tokio::time::timeout_at(deadline, dial(&ep, &addr, &visit, &ticket)) => r,
            _ = closed_by_core(&mut cmds) => return,
        };
        match dialled {
            Ok(Ok(est)) => {
                let _ = core.send(if first { Ev::LinkUp { visit: visit.clone() } } else { Ev::LinkBack { visit: visit.clone() } });
                first = false;
                match run(Role::Visitor, &visit, est, &mut cmds, &core, None).await {
                    Ended::Closed => return,
                    Ended::Lost | Ended::Replaced(_) => {
                        info!(%visit, "link lost; redialling");
                        let _ = core.send(Ev::LinkLost { visit: visit.clone() });
                        deadline = Instant::now() + GRACE;
                    }
                }
            }
            Ok(Err(e)) if e.is::<Refused>() => {
                warn!(%visit, "{e}");
                let _ = core.send(Ev::LinkFailed { visit });
                return;
            }
            Ok(Err(e)) => {
                debug!(%visit, "dial failed: {e:#}");
                if Instant::now() + REDIAL >= deadline {
                    let _ = core.send(Ev::LinkFailed { visit });
                    return;
                }
                tokio::select! {
                    _ = tokio::time::sleep(REDIAL) => {}
                    _ = closed_by_core(&mut cmds) => return,
                }
            }
            Err(_) => {
                let _ = core.send(Ev::LinkFailed { visit });
                return;
            }
        }
    }
}

async fn host_task(visit: String, mut arrivals: mpsc::Receiver<Established>, mut cmds: mpsc::Receiver<LinkCmd>, core: mpsc::UnboundedSender<Ev>) {
    let (mut deadline, mut first, mut next) = (Instant::now() + DIAL_TIMEOUT, true, None);
    loop {
        let est = match next.take() {
            Some(est) => est,
            None => tokio::select! {
                r = tokio::time::timeout_at(deadline, arrivals.recv()) => match r {
                    Ok(Some(est)) => est,
                    Ok(None) => return,
                    Err(_) => { let _ = core.send(Ev::LinkFailed { visit }); return; }
                },
                _ = closed_by_core(&mut cmds) => return,
            },
        };
        let _ = core.send(if first { Ev::LinkUp { visit: visit.clone() } } else { Ev::LinkBack { visit: visit.clone() } });
        first = false;
        match run(Role::Host, &visit, est, &mut cmds, &core, Some(&mut arrivals)).await {
            Ended::Closed => return,
            Ended::Replaced(est) => next = Some(est),
            Ended::Lost => {
                info!(%visit, "link lost; waiting for the visitor to redial");
                let _ = core.send(Ev::LinkLost { visit: visit.clone() });
                deadline = Instant::now() + GRACE;
            }
        }
    }
}

enum Ended {
    /// Ended on purpose, by either side (no redialling).
    Closed,
    /// The connection went: redial (visitor) or wait for a redial (host), for the grace period.
    Lost,
    /// The visitor dialled again while this connection still looked alive: carry on with the new one.
    Replaced(Established),
}

/// How a connection that has gone ended, for the link: on purpose (closed here, or by the other side with
/// 0 bye, 1 refused or 3 visit over), or lost (anything else: redial, or wait for a redial).
fn ending(conn: &Connection) -> Ended {
    match conn.close_reason() {
        Some(ConnectionError::LocallyClosed) => Ended::Closed,
        Some(ConnectionError::ApplicationClosed(c)) if matches!(c.error_code.into_inner(), 0 | 1 | 3) => Ended::Closed,
        _ => Ended::Lost,
    }
}

async fn next_arrival(arrivals: &mut Option<&mut mpsc::Receiver<Established>>) -> Established {
    match arrivals {
        Some(rx) => match rx.recv().await {
            Some(est) => est,
            None => std::future::pending().await,
        },
        None => std::future::pending().await,
    }
}

/// One connection of a visit's link, until it ends.
async fn run(role: Role, visit: &str, est: Established, cmds: &mut mpsc::Receiver<LinkCmd>, core: &mpsc::UnboundedSender<Ev>, mut arrivals: Option<&mut mpsc::Receiver<Established>>) -> Ended {
    let Established { conn, mut send, recv, meta } = est;
    let (ctl_tx, mut ctl_rx) = mpsc::channel::<Value>(64);
    let mut tasks: Vec<JoinHandle<()>> = vec![tokio::spawn(read_ctl(recv, ctl_tx))];
    let (need_key, newest) = (Arc::new(AtomicBool::new(true)), Arc::new(AtomicU64::new(0)));
    let video = match role {
        Role::Host => {
            let (tx, rx) = mpsc::channel::<Frame>(32);
            tasks.push(tokio::spawn(write_video(conn.clone(), rx, need_key.clone(), newest.clone(), meta, visit.to_string(), core.clone())));
            Some(tx)
        }
        Role::Visitor => {
            tasks.push(tokio::spawn(read_video(conn.clone(), visit.to_string(), core.clone())));
            None
        }
    };
    let (mut bitrate, mut tick, mut path) = (Bitrate::new(), tokio::time::interval(Duration::from_secs(1)), None::<bool>);
    let ended = loop {
        tokio::select! {
            msg = ctl_rx.recv() => match msg {
                Some(m) if m.get("bye").is_some() => break Ended::Closed,
                Some(m) => { let _ = core.send(Ev::LinkCtl { visit: visit.to_string(), msg: m }); }
                // The other side's control stream ended: its connection is closing (say how), or should be.
                None => { let _ = tokio::time::timeout(Duration::from_secs(2), conn.closed()).await; break ending(&conn) }
            },
            d = conn.read_datagram(), if role == Role::Host => match d {
                Ok(b) => if let Ok(v) = serde_json::from_slice::<Value>(&b) { let _ = core.send(Ev::LinkInput { visit: visit.to_string(), msg: v }); },
                Err(_) => break ending(&conn),
            },
            cmd = cmds.recv() => match cmd {
                Some(LinkCmd::Ctl(v)) => if frames::write_msg(&mut send, &v).await.is_err() { break ending(&conn) },
                Some(LinkCmd::Input(v)) => { let _ = conn.send_datagram(Bytes::from(serde_json::to_vec(&v).unwrap_or_default())); }
                Some(LinkCmd::Frame(f)) => if let Some(tx) = &video {
                    newest.fetch_max(f.ts, Ordering::SeqCst);
                    // The writer cannot keep up: drop frames until the next keyframe, and ask for one.
                    if tx.try_send(f).is_err() && !need_key.swap(true, Ordering::SeqCst) {
                        let _ = core.send(Ev::WantKey { visit: visit.to_string() });
                    }
                },
                Some(LinkCmd::Close(why)) => {
                    let _ = frames::write_msg(&mut send, &json!({ "bye": why })).await;
                    let _ = send.finish();
                    conn.close(VarInt::from_u32(0), why.as_bytes());
                    break Ended::Closed;
                }
                None => { conn.close(VarInt::from_u32(3), b"visit over"); break Ended::Closed }
            },
            _ = tick.tick() => {
                // Which way the link goes (direct, or through a relay: slower, and rate-limited) and how long a
                // round trip takes, for the page and the log.
                if let Some(p) = conn.paths().iter().find(|p| p.is_selected()) {
                    let (relay, rtt) = (p.is_relay(), p.rtt());
                    if path != Some(relay) {
                        info!(%visit, path = if relay { "relay" } else { "direct" }, rtt_ms = rtt.as_millis() as u64, "link path");
                        path = Some(relay);
                    }
                    let _ = core.send(Ev::LinkStats { visit: visit.to_string(), relay, rtt_ms: rtt.as_secs_f64() * 1000.0 });
                }
                if role == Role::Host {
                    let _ = core.send(Ev::Bitrate { visit: visit.to_string(), bps: bitrate.update(&conn) });
                }
            }
            est = next_arrival(&mut arrivals) => { conn.close(VarInt::from_u32(0), b"replaced"); break Ended::Replaced(est) }
            _ = conn.closed() => break ending(&conn),
        }
    };
    for t in tasks {
        t.abort();
    }
    ended
}

async fn read_ctl(mut recv: RecvStream, tx: mpsc::Sender<Value>) {
    while let Ok(Some(m)) = frames::read_msg(&mut recv).await {
        if tx.send(m).await.is_err() {
            return;
        }
    }
}

/// The host's side of the video: each keyframe starts a new stream, cutting off what is left of the older
/// one (reset, not finished: its unsent frames are stale). A frame BEHIND_US older than the newest one
/// waiting means the link is behind: the rest of that group is dropped, and the page asked for a keyframe.
async fn write_video(conn: Connection, mut rx: mpsc::Receiver<Frame>, need_key: Arc<AtomicBool>, newest: Arc<AtomicU64>, meta: bool, visit: String, core: mpsc::UnboundedSender<Ev>) {
    let mut cur: Option<SendStream> = None;
    while let Some(f) = rx.recv().await {
        if f.key {
            if let Some(mut old) = cur.take() {
                let _ = old.reset(VarInt::from_u32(0));
            }
            match conn.open_uni().await {
                Ok(s) => cur = Some(s),
                Err(e) => return debug!("cannot open a video stream: {e}"),
            }
            need_key.store(false, Ordering::SeqCst);
        } else if need_key.load(Ordering::SeqCst) {
            continue;
        } else if newest.load(Ordering::SeqCst).saturating_sub(f.ts) > BEHIND_US {
            debug!(%visit, behind_ms = (newest.load(Ordering::SeqCst) - f.ts) / 1000, "the link is behind: dropping to the next keyframe");
            need_key.store(true, Ordering::SeqCst);
            let _ = core.send(Ev::WantKey { visit: visit.clone() });
            continue;
        }
        if let Some(s) = cur.as_mut() {
            trace!(key = f.key, ts = f.ts, len = f.data.len(), "frame out");
            if let Err(e) = s.write_all(&f.to_link(meta)).await {
                debug!("a video stream failed: {e}");
                cur = None;
                need_key.store(true, Ordering::SeqCst);
            }
        }
    }
}

/// The visitor's side of the video: streams in the order they started; a newer one abandons the older
/// (dropping its reader stops it), so a stalled group of pictures is never waited for.
async fn read_video(conn: Connection, visit: String, core: mpsc::UnboundedSender<Ev>) {
    let mut reader: Option<JoinHandle<()>> = None;
    while let Ok(mut stream) = conn.accept_uni().await {
        if let Some(old) = reader.take() {
            old.abort();
        }
        let (core, visit) = (core.clone(), visit.clone());
        debug!(%visit, "a new group of pictures");
        reader = Some(tokio::spawn(async move {
            loop {
                match frames::read_link_frame(&mut stream).await {
                    Ok(Some(frame)) => {
                        trace!(%visit, key = frame.key, ts = frame.ts, len = frame.data.len(), "frame in");
                        if core.send(Ev::LinkFrame { visit: visit.clone(), frame }).is_err() {
                            return;
                        }
                    }
                    Ok(None) => return,
                    Err(e) => return debug!(%visit, "a video stream broke off: {e:#}"),
                }
            }
        }));
    }
    if let Some(old) = reader {
        old.abort();
    }
}

/// The bitrate a host should encode a visit at (../SPEC.md section 7.5), from the link's loss and
/// round-trip time over the last second.
struct Bitrate {
    bps: u64,
    sent: u64,
    lost: u64,
    min_rtt: Option<Duration>,
}

impl Bitrate {
    fn new() -> Self {
        Bitrate { bps: 2_000_000, sent: 0, lost: 0, min_rtt: None }
    }

    fn update(&mut self, conn: &Connection) -> u64 {
        let s = conn.stats();
        let (sent, lost) = (s.sent_packets.saturating_sub(self.sent), s.lost_packets.saturating_sub(self.lost));
        (self.sent, self.lost) = (s.sent_packets, s.lost_packets);
        let rtt = conn.paths().iter().find(|p| p.is_selected()).map(|p| p.rtt());
        if let Some(r) = rtt {
            self.min_rtt = Some(self.min_rtt.map_or(r, |m| m.min(r)));
        }
        let loss = if sent > 0 { lost as f64 / sent as f64 } else { 0.0 };
        // Slower by half again, and by more than 20 ms (a loopback link's microseconds are noise).
        let slower = matches!((rtt, self.min_rtt), (Some(r), Some(m)) if r.as_secs_f64() > m.as_secs_f64() * 1.5 && r > m + Duration::from_millis(20));
        let next = if loss > 0.02 || slower { self.bps * 7 / 10 } else { self.bps + 150_000 };
        self.bps = next.clamp(300_000, 6_000_000);   // 6 Mbit/s: 720p at 60 frames a second
        self.bps
    }
}
