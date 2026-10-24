//! The visit-client's core: one task owns all its state (the office, the lobby as last seen, the knocks
//! on its door, the visits) and routes what comes in from the page, the lobby and the links (../SPEC.md
//! sections 4-8). Everything else talks to it through `Ev`s.
use std::{
    collections::{BTreeMap, HashMap},
    time::{Duration, Instant},
};

use bytes::Bytes;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tracing::{debug, info, trace, warn};

use crate::{
    frames::Frame,
    link::{LinkCmd, Links, Relays, Role},
    lobby::LobbyOut,
    VERSION,
};

/// What the core hears about.
pub enum Ev {
    PageOpen { id: u64, tx: mpsc::Sender<PageOut> },
    PageMsg { id: u64, msg: Value },
    PageBin { id: u64, data: Bytes },
    PageClosed { id: u64 },
    Lobby(Value),
    LobbyDown,
    /// The lobby refused this office for good (bad name, protocol): exit with this code.
    Fatal(i32),
    LinkAddr { endpoint: String, addr: Value },
    LinkUp { visit: String },
    LinkBack { visit: String },
    LinkLost { visit: String },
    LinkCtl { visit: String, msg: Value },
    LinkInput { visit: String, msg: Value },
    LinkFrame { visit: String, frame: Frame },
    LinkFailed { visit: String },
    Bitrate { visit: String, bps: u64 },
    WantKey { visit: String },
    Tick,
    Shutdown,
}

/// What goes to the page.
pub enum PageOut {
    Text(String),
    Binary(Bytes),
    Close(u16, &'static str),
}

struct Page {
    id: u64,
    tx: mpsc::Sender<PageOut>,
}

struct Visit {
    id: String,
    channel: u16,
    role: Role,
    peer: Value,
    /// Its link has passed the handshake (it has been `visit_started` to the page).
    up: bool,
    cmd: mpsc::Sender<LinkCmd>,
    /// The host's encoder settings (visitor side), for a page that connects later.
    video_config: Option<Value>,
    /// The highest input sequence number seen, and the inputs taken in the current second (host side).
    last_seq: u64,
    inputs: (Instant, u32),
    /// A frame for the page was dropped (visitor side): ask the host for a keyframe, once.
    want_key: bool,
    /// What the visitor decodes and how big its view is (host side), for a page that connects later.
    peer_decoders: Option<Value>,
    peer_viewport: Option<Value>,
}

pub struct Core {
    lobby: mpsc::UnboundedSender<LobbyOut>,
    me: mpsc::UnboundedSender<Ev>,
    relays: Option<Relays>,
    links: Option<Links>,
    link: Option<(String, Value)>,
    page: Option<Page>,
    page_gone: Instant,
    idle_exit: u64,
    online: bool,
    office: Value,
    status: String,
    max_visitors: u8,
    lobby_view: Option<Value>,
    knocks: BTreeMap<String, Value>,
    visits: HashMap<String, Visit>,
    next_channel: u16,
    /// What this office's page decodes and how big its view is, to tell the rooms it visits.
    decoders: Option<Value>,
    viewport: Option<Value>,
    input_seq: u64,
}

const LIMITS: fn() -> Value = || json!({ "max_width": 1280, "max_height": 720, "fps": 30 });

impl Core {
    pub fn new(lobby: mpsc::UnboundedSender<LobbyOut>, me: mpsc::UnboundedSender<Ev>, relays: Option<Relays>, max_visitors: u8, idle_exit: u64) -> Core {
        Core {
            lobby,
            me,
            relays,
            links: None,
            link: None,
            page: None,
            page_gone: Instant::now(),
            idle_exit,
            online: false,
            office: Value::Null,
            status: "available".into(),
            max_visitors,
            lobby_view: None,
            knocks: BTreeMap::new(),
            visits: HashMap::new(),
            next_channel: 1,
            decoders: None,
            viewport: None,
            input_seq: 0,
        }
    }

    /// Runs until shut down; the exit code.
    pub async fn run(mut self, mut rx: mpsc::UnboundedReceiver<Ev>) -> i32 {
        while let Some(ev) = rx.recv().await {
            match ev {
                Ev::Shutdown => break,
                Ev::Fatal(code) => {
                    self.shutdown().await;
                    return code;
                }
                Ev::Tick => {
                    if self.idle_exit > 0 && self.page.is_none() && self.page_gone.elapsed() >= Duration::from_secs(self.idle_exit) {
                        info!("no page for {} s: exiting", self.idle_exit);
                        break;
                    }
                }
                ev => self.handle(ev).await,
            }
        }
        self.shutdown().await;
        0
    }

    async fn shutdown(&mut self) {
        let _ = self.lobby.send(LobbyOut::Bye);
        for v in self.visits.values() {
            let _ = v.cmd.try_send(LinkCmd::Close("gone".into()));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        if let Some(links) = &self.links {
            links.close().await;
        }
    }

    async fn handle(&mut self, ev: Ev) {
        match ev {
            Ev::PageOpen { id, tx } => self.page_open(id, tx),
            Ev::PageClosed { id } => {
                if self.page.as_ref().map(|p| p.id) == Some(id) {
                    self.page = None;
                    self.page_gone = Instant::now();
                    self.tell_hosted(json!({ "paused": true }));
                }
            }
            Ev::PageMsg { id, msg } => {
                if self.page.as_ref().map(|p| p.id) == Some(id) {
                    self.page_msg(msg);
                }
            }
            Ev::PageBin { id, data } => {
                if self.page.as_ref().map(|p| p.id) == Some(id) {
                    self.page_frame(&data);
                }
            }
            Ev::Lobby(msg) => self.lobby_msg(msg).await,
            Ev::LobbyDown => {
                if self.online {
                    self.online = false;
                    self.to_page(json!({ "type": "offline" }));
                }
            }
            Ev::LinkAddr { endpoint, addr } => {
                self.link = Some((endpoint, addr));
                self.publish_link();
            }
            Ev::LinkUp { visit } => self.link_up(&visit, true),
            Ev::LinkBack { visit } => self.link_up(&visit, false),
            Ev::LinkLost { visit } => info!(%visit, "link lost"),
            Ev::LinkCtl { visit, msg } => self.link_ctl(&visit, msg),
            Ev::LinkInput { visit, msg } => self.link_input(&visit, msg),
            Ev::LinkFrame { visit, frame } => self.link_frame(&visit, frame),
            Ev::LinkFailed { visit } => {
                warn!(%visit, "the link could not be made or came back");
                self.to_lobby(json!({ "type": "end", "visit": visit, "reason": "link_failed" }));
            }
            Ev::Bitrate { visit, bps } => {
                if let Some(v) = self.visits.get(&visit) {
                    let ch = v.channel;
                    self.to_page(json!({ "type": "bitrate", "channel": ch, "bps": bps }));
                }
            }
            Ev::WantKey { visit } => {
                if let Some(v) = self.visits.get(&visit) {
                    let ch = v.channel;
                    self.to_page(json!({ "type": "keyframe", "channel": ch }));
                }
            }
            Ev::Tick | Ev::Shutdown | Ev::Fatal(_) => {}
        }
    }

    // ---------- the page ----------

    fn page_open(&mut self, id: u64, tx: mpsc::Sender<PageOut>) {
        if let Some(old) = self.page.take() {
            let _ = old.tx.try_send(PageOut::Close(4409, "replaced"));
        }
        self.page = Some(Page { id, tx });
        let visits: Vec<Value> = self.visits.values().filter(|v| v.up).map(started).collect();
        self.to_page(json!({
            "type": "ready", "version": VERSION, "office": self.office, "online": self.online, "status": self.status,
            "max_visitors": self.max_visitors, "visits": visits, "limits": LIMITS(),
        }));
        if let Some(view) = self.lobby_view.clone() {
            self.to_page(view);
        }
        for k in self.knocks.values().cloned().collect::<Vec<_>>() {
            self.to_page(k);
        }
        self.tell_hosted(json!({ "paused": false }));
        // A visit to this office: what its visitor decodes and how big its view is, to encode for.
        let hosted: Vec<Value> = self.visits.values().filter(|v| v.up && v.role == Role::Host)
            .flat_map(|v| [v.peer_decoders.clone(), v.peer_viewport.clone()]).flatten().collect();
        for m in hosted {
            self.to_page(m);
        }
        // A visit this page is on: the host's encoder settings, and a keyframe to start decoding from.
        let mine: Vec<(u16, Option<Value>, mpsc::Sender<LinkCmd>)> =
            self.visits.values().filter(|v| v.up && v.role == Role::Visitor).map(|v| (v.channel, v.video_config.clone(), v.cmd.clone())).collect();
        for (ch, cfg, cmd) in mine {
            if let Some(cfg) = cfg {
                self.to_page(with_channel("video_config", ch, &cfg));
            }
            let _ = cmd.try_send(LinkCmd::Ctl(json!({ "keyframe": true })));
        }
    }

    fn page_msg(&mut self, m: Value) {
        let t = m.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        match t.as_str() {
            "" => self.page_error("bad_message", "a message is a JSON object with a string `type`", None),
            "hello" => self.page_error("already_hello", "this connection has said hello", Some("hello")),
            "status" | "max_visitors" | "knock" | "answer" => {
                if t == "status" {
                    if let Some(s) = m.get("status").and_then(Value::as_str) {
                        self.status = s.to_string();
                    }
                }
                if t == "max_visitors" {
                    if let Some(n) = m.get("n").and_then(Value::as_u64) {
                        self.max_visitors = n.min(8) as u8;
                    }
                }
                if t == "answer" {   // answered: no longer waiting, so not shown again to a page that reconnects
                    if let Some(k) = m.get("knock").and_then(Value::as_str) {
                        self.knocks.remove(k);
                    }
                }
                self.to_lobby(m);
            }
            "rename" => match m.get("name").and_then(Value::as_str) {
                Some(n) if crate::name_ok(n) => {
                    let _ = self.lobby.send(LobbyOut::Rename(n.to_string()));
                }
                _ => self.page_error("name_invalid", "a name is 1-24 letters, digits, spaces, _ . -, starting and ending with a letter or digit", Some("rename")),
            },
            "end" => {
                let visit = m.get("visit").and_then(Value::as_str).unwrap_or("");
                if self.visits.contains_key(visit) {
                    let v = visit.to_string();
                    self.to_lobby(json!({ "type": "end", "visit": v }));
                } else {
                    self.page_error("no_such_visit", "you are not in a visit with that id", Some("end"));
                }
            }
            "input" => {
                self.input_seq += 1;
                let mut input = clamp_input(&m);
                input["seq"] = json!(self.input_seq);
                if let Some(v) = self.visiting() {
                    let _ = v.cmd.try_send(LinkCmd::Input(input));
                }
            }
            "viewport" => {
                let vp = json!({ "width": m.get("width").and_then(Value::as_u64).unwrap_or(0).min(8192),
                                  "height": m.get("height").and_then(Value::as_u64).unwrap_or(0).min(8192) });
                self.viewport = Some(vp.clone());
                if let Some(v) = self.visiting() {
                    let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "viewport": vp })));
                }
            }
            "decoders" => {
                let codecs = m.get("codecs").cloned().unwrap_or(json!([]));
                self.decoders = Some(codecs.clone());
                if let Some(v) = self.visiting() {
                    let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "decoders": codecs })));
                }
            }
            "keyframe" | "video_config" => {
                let ch = m.get("channel").and_then(Value::as_u64).unwrap_or(0) as u16;
                let Some(v) = self.visits.values().find(|v| v.channel == ch && v.up) else {
                    return self.page_error("no_such_visit", "no visit on that channel", Some(&t));
                };
                let ctl = if t == "keyframe" {
                    json!({ "keyframe": true })
                } else {
                    json!({ "video_config": { "codec": m.get("codec"), "width": m.get("width"), "height": m.get("height") } })
                };
                let _ = v.cmd.try_send(LinkCmd::Ctl(ctl));
            }
            other => {
                let other = other.to_string();
                self.page_error("unknown_type", &format!("no message type {other:?}"), Some(&other));
            }
        }
    }

    /// A frame of this office's room, rendered for one of its visitors.
    fn page_frame(&mut self, data: &[u8]) {
        let Some((ch, frame)) = Frame::from_page(data) else { return debug!(len = data.len(), "a malformed frame from the page") };
        match self.visits.values().find(|v| v.channel == ch && v.role == Role::Host && v.up) {
            Some(v) => {
                if v.cmd.try_send(LinkCmd::Frame(frame)).is_err() {
                    debug!(ch, "the link is not taking frames");
                }
            }
            None => debug!(ch, "a frame for no visit"),
        }
    }

    fn to_page(&mut self, v: Value) {
        let full = match &self.page {
            Some(p) => p.tx.try_send(PageOut::Text(v.to_string())).is_err(),
            None => false,
        };
        if full {
            warn!("the page is not keeping up: dropping it");
            self.page = None;
            self.page_gone = Instant::now();
        }
    }

    fn page_error(&mut self, code: &str, message: &str, re: Option<&str>) {
        let mut e = json!({ "type": "error", "code": code, "message": message });
        if let Some(r) = re {
            e["ref"] = json!(r);
        }
        self.to_page(e);
    }

    // ---------- the lobby ----------

    fn to_lobby(&mut self, m: Value) {
        if self.online {
            let _ = self.lobby.send(LobbyOut::Msg(m));
        } else {
            let re = m.get("type").and_then(Value::as_str).map(str::to_string);
            self.page_error("offline", "the lobby is not reachable right now", re.as_deref());
        }
    }

    fn publish_link(&mut self) {
        if let (true, Some((endpoint, addr))) = (self.online, self.link.clone()) {
            let _ = self.lobby.send(LobbyOut::Msg(json!({ "type": "link", "endpoint": endpoint, "addr": addr })));
        }
    }

    async fn lobby_msg(&mut self, m: Value) {
        let t = m.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        match t.as_str() {
            "welcome" => {
                let resumed = m.get("resumed").and_then(Value::as_bool).unwrap_or(false);
                if !resumed {
                    self.end_all("gone");
                    self.knocks.clear();
                }
                self.office = json!({ "id": m.get("id"), "name": m.get("name") });
                self.online = true;
                if self.links.is_none() {
                    let relays = self.relays.take().unwrap_or_else(|| {
                        let urls: Vec<String> = m.get("relays").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
                        if urls.is_empty() { Relays::Default } else { Relays::Custom(urls) }
                    });
                    match Links::start(relays, self.me.clone()).await {
                        Ok(l) => self.links = Some(l),
                        Err(e) => warn!("could not start the link endpoint: {e:#}"),
                    }
                }
                info!(office = %self.office, resumed, "in the lobby");
                self.publish_link();
                let office = self.office.clone();
                self.to_page(json!({ "type": "online", "office": office }));
            }
            "lobby" => {
                self.lobby_view = Some(m.clone());
                self.to_page(m);
            }
            "knock" => {
                if let Some(id) = m.get("id").and_then(Value::as_str) {
                    self.knocks.insert(id.to_string(), m.clone());
                }
                self.to_page(m);
            }
            "knock_cancelled" => {
                if let Some(id) = m.get("id").and_then(Value::as_str) {
                    self.knocks.remove(id);
                }
                self.to_page(m);
            }
            "visit" => self.visit_agreed(&m),
            "visit_ended" => {
                let id = m.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                let reason = m.get("reason").and_then(Value::as_str).unwrap_or("gone").to_string();
                self.end_visit(&id, &reason);
            }
            _ => self.to_page(m),
        }
    }

    // ---------- visits ----------

    fn visit_agreed(&mut self, m: &Value) {
        let (Some(id), Some(ticket), Some(role)) = (
            m.get("id").and_then(Value::as_str),
            m.get("ticket").and_then(Value::as_str),
            m.get("role").and_then(Value::as_str),
        ) else {
            return warn!("a visit without an id, ticket or role");
        };
        let Some(links) = self.links.clone() else {
            return self.to_lobby(json!({ "type": "end", "visit": id, "reason": "link_failed" }));
        };
        let role = if role == "host" { Role::Host } else { Role::Visitor };
        let peer_link = m.get("peer_link").cloned().unwrap_or(Value::Null);
        let cmd = match role {
            Role::Host => links.host(id, ticket, &peer_link),
            Role::Visitor => links.visitor(id, ticket, &peer_link),
        };
        match cmd {
            Ok(cmd) => {
                let channel = self.channel();
                info!(visit = id, ?role, channel, "visit agreed");
                self.visits.insert(id.to_string(), Visit {
                    id: id.to_string(), channel, role, peer: m.get("peer").cloned().unwrap_or(Value::Null), up: false, cmd,
                    video_config: None, last_seq: 0, inputs: (Instant::now(), 0), want_key: false, peer_decoders: None, peer_viewport: None,
                });
            }
            Err(e) => {
                warn!(visit = id, "cannot make its link: {e:#}");
                self.to_lobby(json!({ "type": "end", "visit": id, "reason": "link_failed" }));
            }
        }
    }

    fn channel(&mut self) -> u16 {
        loop {
            let ch = self.next_channel;
            self.next_channel = if ch == u16::MAX { 1 } else { ch + 1 };
            if !self.visits.values().any(|v| v.channel == ch) {
                return ch;
            }
        }
    }

    fn end_visit(&mut self, id: &str, reason: &str) {
        let Some(v) = self.visits.remove(id) else { return };
        let _ = v.cmd.try_send(LinkCmd::Close(reason.to_string()));
        if let Some(links) = &self.links {
            links.forget(id);
        }
        info!(visit = id, reason, "visit ended");
        if v.up {
            self.to_page(json!({ "type": "visit_ended", "id": id, "channel": v.channel, "reason": reason }));
        }
    }

    fn end_all(&mut self, reason: &str) {
        for id in self.visits.keys().cloned().collect::<Vec<_>>() {
            self.end_visit(&id, reason);
        }
    }

    fn visiting(&self) -> Option<&Visit> {
        self.visits.values().find(|v| v.role == Role::Visitor && v.up)
    }

    /// A control message to every visitor of this office.
    fn tell_hosted(&self, ctl: Value) {
        for v in self.visits.values().filter(|v| v.role == Role::Host && v.up) {
            let _ = v.cmd.try_send(LinkCmd::Ctl(ctl.clone()));
        }
    }

    fn link_up(&mut self, id: &str, first: bool) {
        let (decoders, viewport, has_page) = (self.decoders.clone(), self.viewport.clone(), self.page.is_some());
        let Some(v) = self.visits.get_mut(id) else { return };
        v.up = true;
        let (role, cmd) = (v.role, v.cmd.clone());
        let started = started(v);
        match role {
            Role::Visitor => {
                if let Some(d) = decoders {
                    let _ = cmd.try_send(LinkCmd::Ctl(json!({ "decoders": d })));
                }
                if let Some(vp) = viewport {
                    let _ = cmd.try_send(LinkCmd::Ctl(json!({ "viewport": vp })));
                }
                if !first {
                    let _ = cmd.try_send(LinkCmd::Ctl(json!({ "keyframe": true })));
                }
            }
            // No page to render for it yet: the visitor's view waits (it hears host_resumed when one comes).
            Role::Host if !has_page => {
                let _ = cmd.try_send(LinkCmd::Ctl(json!({ "paused": true })));
            }
            Role::Host => {}
        }
        if first {
            info!(visit = id, "link up");
            self.to_page(started);
        } else {
            info!(visit = id, "link back");
        }
    }

    fn link_ctl(&mut self, id: &str, m: Value) {
        let Some(v) = self.visits.get_mut(id) else { return };
        let ch = v.channel;
        match v.role {
            // From the visitor.
            Role::Host => {
                if let Some(codecs) = m.get("decoders") {
                    let msg = json!({ "type": "decoders", "channel": ch, "codecs": codecs });
                    v.peer_decoders = Some(msg.clone());
                    self.to_page(msg);
                } else if let Some(vp) = m.get("viewport") {
                    let (w, h) = (vp.get("width").and_then(Value::as_u64).unwrap_or(0), vp.get("height").and_then(Value::as_u64).unwrap_or(0));
                    let msg = json!({ "type": "viewport", "channel": ch, "width": w.min(8192), "height": h.min(8192) });
                    v.peer_viewport = Some(msg.clone());
                    self.to_page(msg);
                } else if m.get("keyframe").is_some() {
                    self.to_page(json!({ "type": "keyframe", "channel": ch }));
                }
            }
            // From the host.
            Role::Visitor => {
                if let Some(cfg) = m.get("video_config") {
                    v.video_config = Some(cfg.clone());
                    let msg = with_channel("video_config", ch, cfg);
                    self.to_page(msg);
                } else if let Some(p) = m.get("paused").and_then(Value::as_bool) {
                    self.to_page(json!({ "type": if p { "host_paused" } else { "host_resumed" }, "channel": ch }));
                }
            }
        }
    }

    /// A visitor's input, checked and clamped, at most 60 a second, newest only.
    fn link_input(&mut self, id: &str, m: Value) {
        let Some(v) = self.visits.get_mut(id).filter(|v| v.role == Role::Host) else { return };
        let seq = m.get("seq").and_then(Value::as_u64).unwrap_or(0);
        if seq <= v.last_seq {
            return;
        }
        if v.inputs.0.elapsed() >= Duration::from_secs(1) {
            v.inputs = (Instant::now(), 0);
        }
        if v.inputs.1 >= 60 {
            return;
        }
        v.inputs.1 += 1;
        v.last_seq = seq;
        let mut input = clamp_input(&m);
        input["type"] = json!("input");
        input["channel"] = json!(v.channel);
        input["seq"] = json!(seq);
        self.to_page(input);
    }

    /// A frame of the room this office is visiting.
    fn link_frame(&mut self, id: &str, frame: Frame) {
        let Some(v) = self.visits.get_mut(id).filter(|v| v.role == Role::Visitor) else { return debug!(id, "a frame for no visit") };
        let Some(page) = &self.page else { return debug!(id, "a frame with no page to show it") };
        if v.want_key && !frame.key {
            return;
        }
        trace!(id, key = frame.key, ts = frame.ts, "frame to the page");
        if page.tx.try_send(PageOut::Binary(frame.to_page(v.channel))).is_err() {
            if !v.want_key {
                v.want_key = true;
                let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "keyframe": true })));
            }
        } else if frame.key {
            v.want_key = false;
        }
    }
}

fn started(v: &Visit) -> Value {
    json!({ "type": "visit_started", "id": v.id, "channel": v.channel, "role": if v.role == Role::Host { "host" } else { "visitor" }, "peer": v.peer })
}

fn with_channel(kind: &str, channel: u16, cfg: &Value) -> Value {
    json!({ "type": kind, "channel": channel, "codec": cfg.get("codec"), "width": cfg.get("width"), "height": cfg.get("height") })
}

/// An input with every field in its range (../SPEC.md section 8.2).
fn clamp_input(m: &Value) -> Value {
    let step = |k: &str| m.get(k).and_then(Value::as_f64).filter(|x| x.is_finite()).map_or(0, |x| x.round().clamp(-1.0, 1.0) as i64);
    let angle = |k: &str, lim: f64| m.get(k).and_then(Value::as_f64).filter(|x| x.is_finite()).map_or(0.0, |x| x.clamp(-lim, lim));
    json!({
        "forward": step("forward"), "strafe": step("strafe"), "run": m.get("run").and_then(Value::as_bool).unwrap_or(false),
        "yaw": angle("yaw", 1e6), "pitch": angle("pitch", 1.4),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inputs_are_clamped() {
        let i = clamp_input(&json!({ "forward": 5, "strafe": -0.6, "run": "yes", "yaw": 3.0, "pitch": -9 }));
        assert_eq!(i, json!({ "forward": 1, "strafe": -1, "run": false, "yaw": 3.0, "pitch": -1.4 }));
        let j = clamp_input(&json!({}));
        assert_eq!(j, json!({ "forward": 0, "strafe": 0, "run": false, "yaw": 0.0, "pitch": 0.0 }));
    }
}
