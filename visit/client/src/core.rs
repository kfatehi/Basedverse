//! The visit-client's core: one task owns all its state (the office, the lobby as last seen, the knocks
//! on its door, the visits) and routes what comes in from the page, the lobby and the links (../SPEC.md
//! sections 4-8). Everything else talks to it through `Ev`s.
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    time::{Duration, Instant},
};

use bytes::Bytes;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tracing::{debug, info, trace, warn};

use crate::{
    frames::{self, Frame},
    link::{LinkCmd, Links, Relays, Role},
    lobby::LobbyOut,
    state::{self, Guest, Saved},
    VERSION,
};

/// What the core hears about.
pub enum Ev {
    PageOpen { id: u64, text: mpsc::UnboundedSender<PageOut>, frames: mpsc::Sender<Bytes> },
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
    /// The link's path (direct or through a relay) and round-trip time, about once a second.
    LinkStats { visit: String, relay: bool, rtt_ms: f64 },
    WantKey { visit: String },
    /// An edit of the scene of the room this office visits: unpacked, checked JSON (../SPEC.md section 8.3).
    LinkScene { visit: String, json: String },
    /// An edit of that scene was dropped (too big, malformed, too many): the page asks for the whole scene.
    SceneLost { visit: String },
    /// This office's scene edits for a visitor were dropped (its link far behind): the page sends it all again.
    SceneResync { visit: String },
    Tick,
    Shutdown,
}

/// What the page is told (frames go apart, on a queue that drops them when the page falls behind).
pub enum PageOut {
    Text(String),
    Close(u16, &'static str),
}

struct Page {
    id: u64,
    text: mpsc::UnboundedSender<PageOut>,
    frames: mpsc::Sender<Bytes>,
}

struct Visit {
    id: String,
    channel: u16,
    role: Role,
    peer: Value,
    /// Its link has passed the handshake (it has been `visit_started` to the page).
    up: bool,
    cmd: mpsc::Sender<LinkCmd>,
    /// The highest input sequence number seen, and the inputs taken in the current second (host side).
    last_seq: u64,
    inputs: (Instant, u32),
    /// A delta for the page was dropped (visitor side): ask the host for a key delta, once.
    want_key: bool,
    /// The host page's state for this visitor (where it stands), kept for a page that reloads.
    host_state: Option<Value>,
    /// Control messages taken from the other side in the current second: at most CTL_PER_SECOND.
    ctl: (Instant, u32),
    /// When a key delta the visitor asked for was last passed to the page (host side): at most every
    /// KEY_EVERY.
    key_asked: Option<Instant>,
    /// When the visitor last asked for the whole scene (host side): passed on at most every RESYNC_EVERY; one
    /// asked for sooner waits (`resync_due`) and goes when it may, on a tick (never dropped: a visitor's page
    /// that comes back has no scene until it gets one).
    resync_asked: Option<Instant>,
    resync_due: bool,
    /// Points taken from the visitor in the current second (host side): at most POINTS_PER_SECOND.
    points: (Instant, u32),
    /// A guest let in without knocking, through the open door (host side).
    guest: bool,
}

/// The most control messages a link's other side may send a second; more are dropped (a peer flooding
/// requests must not swamp this office's page).
const CTL_PER_SECOND: u32 = 20;
const KEY_EVERY: Duration = Duration::from_millis(500);
const RESYNC_EVERY: Duration = Duration::from_secs(2);
/// The most inputs a second taken from a visitor (it sends one whenever its keys or look change, at most
/// every 8 ms, and every 33 ms regardless).
const INPUTS_PER_SECOND: u32 = 120;
/// The most points a second taken from a visitor (a click at the middle of its view: 8.3); more are dropped.
/// Its page sends at most one every 200 ms.
const POINTS_PER_SECOND: u32 = 5;
/// How long a guest let in through the open door is waited for, to be agreed as a visit by the lobby.
const ADMITTED_FOR: Duration = Duration::from_secs(120);

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
    /// What outlasts a run, kept in `state_file`: whether the page took this office out of the lobby
    /// (leave_lobby, until join_lobby), its key, its door and its guests.
    saved: Saved,
    state_file: Option<PathBuf>,
    /// The office's key, as others see it: its link endpoint's public key.
    key: String,
    /// Guests let in through the open door (knocker's office id -> its key, and when), until the lobby agrees
    /// their visit: then the visitor's link must be that key.
    admitted: HashMap<String, (String, Instant)>,
    office: Value,
    status: String,
    max_visitors: u8,
    lobby_view: Option<Value>,
    /// Knocks on this office's door still waiting, and when each came, for a page that connects later.
    knocks: BTreeMap<String, (Value, Instant)>,
    visits: HashMap<String, Visit>,
    next_channel: u16,
    /// The three.js revision of the scene this office's page hosts (`host`): only then is the office in the
    /// lobby to be visited, or knocking (../SPEC.md section 4.2). None while no page hosts.
    hosting: Option<String>,
    input_seq: u64,
}

impl Core {
    pub fn new(lobby: mpsc::UnboundedSender<LobbyOut>, me: mpsc::UnboundedSender<Ev>, relays: Option<Relays>, max_visitors: u8, idle_exit: u64,
               saved: Saved, fresh: bool, state_file: Option<PathBuf>) -> Core {
        let key = saved.key.public().to_string();
        let core = Core {
            lobby,
            me,
            relays,
            links: None,
            link: None,
            page: None,
            page_gone: Instant::now(),
            idle_exit,
            online: false,
            saved,
            state_file,
            key,
            admitted: HashMap::new(),
            office: Value::Null,
            status: "available".into(),
            max_visitors,
            lobby_view: None,
            knocks: BTreeMap::new(),
            visits: HashMap::new(),
            next_channel: 1,
            hosting: None,
            input_seq: 0,
        };
        if fresh {
            core.save_state();   // a key made just now: kept, so it is this office's from now on
        }
        core
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
                    self.resyncs();
                    self.admitted.retain(|_, (_, at)| at.elapsed() < ADMITTED_FOR);
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
            Ev::PageOpen { id, text, frames } => self.page_open(id, text, frames),
            Ev::PageClosed { id } => {
                if self.page.as_ref().map(|p| p.id) == Some(id) {
                    self.page = None;
                    self.page_gone = Instant::now();
                    self.tell_hosted(json!({ "paused": true }));
                    self.set_hosting(None);   // no page, no room to show: not to be visited until one hosts again
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
            Ev::LinkStats { visit, relay, rtt_ms } => {
                if let Some(v) = self.visits.get(&visit) {
                    let ch = v.channel;
                    self.to_page(json!({ "type": "link_stats", "channel": ch, "path": if relay { "relay" } else { "direct" }, "rtt_ms": (rtt_ms * 10.0).round() / 10.0 }));
                }
            }
            Ev::WantKey { visit } => {
                if let Some(v) = self.visits.get(&visit) {
                    let ch = v.channel;
                    self.to_page(json!({ "type": "keyframe", "channel": ch }));
                }
            }
            Ev::LinkScene { visit, json } => {
                if let Some(v) = self.visits.get(&visit).filter(|v| v.role == Role::Visitor) {
                    // Already checked JSON: wrapped as it is, not parsed again.
                    let msg = format!("{{\"type\":\"scene\",\"channel\":{},\"edit\":{json}}}", v.channel);
                    if let Some(p) = &self.page {
                        let _ = p.text.send(PageOut::Text(msg));
                    }
                }
            }
            Ev::SceneLost { visit } | Ev::SceneResync { visit } => {
                let lost = self.visits.get(&visit).map(|v| (v.channel, v.role));
                match lost {
                    Some((ch, Role::Visitor)) => self.to_page(json!({ "type": "scene_lost", "channel": ch })),
                    Some((ch, Role::Host)) => self.to_page(json!({ "type": "scene_resync", "channel": ch })),
                    None => {}
                }
            }
            Ev::Tick | Ev::Shutdown | Ev::Fatal(_) => {}
        }
    }

    // ---------- the page ----------

    fn page_open(&mut self, id: u64, text: mpsc::UnboundedSender<PageOut>, frames: mpsc::Sender<Bytes>) {
        if let Some(old) = self.page.take() {
            let _ = old.text.send(PageOut::Close(4409, "replaced"));
        }
        self.page = Some(Page { id, text, frames });
        let visits: Vec<Value> = self.visits.values().filter(|v| v.up).map(started).collect();
        self.to_page(json!({
            "type": "ready", "version": VERSION, "office": self.office, "online": self.online, "away": self.saved.away, "status": self.status,
            "max_visitors": self.max_visitors, "visits": visits, "key": self.key, "door": self.door(), "guests": self.guests(),
        }));
        if let Some(view) = self.lobby_view.clone() {
            self.to_page(view);
        }
        // Knocks still waiting, each with the time it has left.
        for (k, at) in self.knocks.values().cloned().collect::<Vec<_>>() {
            let left = k.get("expires_in").and_then(Value::as_u64).unwrap_or(60).saturating_sub(at.elapsed().as_secs());
            let mut k = k;
            k["expires_in"] = json!(left);
            self.to_page(k);
        }
        self.tell_hosted(json!({ "paused": false }));
        // A visit this page is on: the host's whole scene again (a page that comes back has none), and a key delta.
        for v in self.visits.values().filter(|v| v.up && v.role == Role::Visitor) {
            let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "scene_resync": true })));
            let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "keyframe": true })));
        }
    }

    fn page_msg(&mut self, m: Value) {
        let t = m.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        match t.as_str() {
            "" => self.page_error("bad_message", "a message is a JSON object with a string `type`", None),
            "hello" => self.page_error("already_hello", "this connection has said hello", Some("hello")),
            "status" => match m.get("status").and_then(Value::as_str) {
                Some(s @ ("available" | "busy")) => {
                    self.status = s.to_string();
                    self.to_lobby(json!({ "type": "status", "status": s }));
                }
                _ => self.page_error("bad_message", "status must be available or busy", Some("status")),
            },
            "max_visitors" => match m.get("n").and_then(Value::as_u64).filter(|n| *n <= 8) {
                Some(n) => {
                    self.max_visitors = n as u8;
                    self.to_lobby(json!({ "type": "max_visitors", "n": n }));
                }
                None => self.page_error("bad_message", "n must be 0 to 8", Some("max_visitors")),
            },
            "leave_lobby" => self.set_away(true),
            // The door, and who walks in through it without knocking (kept in the state file).
            "door" => match m.get("open").and_then(Value::as_bool) {
                Some(open) => {
                    self.saved.door_open = open;
                    self.save_state();
                    self.tell_guests();
                }
                None => self.page_error("bad_message", "open must be true or false", Some("door")),
            },
            "guest_add" => match m.get("key").and_then(Value::as_str).filter(|k| state::key_ok(k)) {
                Some(k) if k == self.key => self.page_error("bad_message", "that is this office's own key", Some("guest_add")),
                Some(k) => {
                    let (k, name) = (k.to_string(), state::clip_name(m.get("name").and_then(Value::as_str).unwrap_or("")));
                    let full = self.saved.guests.len() >= state::MAX_GUESTS;
                    match self.saved.guests.iter_mut().find(|g| g.key == k) {
                        Some(g) => g.name = name,
                        None if full => {
                            return self.page_error("too_many_guests", &format!("at most {} guests", state::MAX_GUESTS), Some("guest_add"));
                        }
                        None => self.saved.guests.push(Guest { key: k, name }),
                    }
                    self.save_state();
                    self.tell_guests();
                }
                None => self.page_error("bad_message", "key is an office's key, as the lobby lists it", Some("guest_add")),
            },
            "guest_remove" => match m.get("key").and_then(Value::as_str) {
                Some(k) => {
                    self.saved.guests.retain(|g| g.key != k);
                    self.save_state();
                    self.tell_guests();
                }
                None => self.page_error("bad_message", "key is the guest's key", Some("guest_remove")),
            },
            "join_lobby" => self.set_away(false),
            "host" => match m.get("three").and_then(Value::as_str).filter(|r| revision(r)) {
                Some(r) => {
                    let r = r.to_string();
                    self.set_hosting(Some(r));
                }
                None => self.page_error("bad_message", "three is the three.js revision of the scene hosted (digits)", Some("host")),
            },
            "knock" if self.hosting.is_none() => {
                self.page_error("not_hosting", "an office takes part once its page hosts its three.js scene (visit.host)", Some("knock"));
            }
            "knock" | "answer" => {
                if t == "answer" {   // answered: no longer waiting, so not shown again to a page that reconnects
                    if let Some(k) = m.get("knock").and_then(Value::as_str) {
                        self.knocks.remove(k);
                    }
                }
                self.to_lobby(m);
            }
            // The lobby renames the office if the name is free; if not, it stays as it was (and says why).
            "rename" => match m.get("name").and_then(Value::as_str) {
                Some(n) if crate::name_ok(n) => {
                    let n = n.to_string();
                    self.to_lobby(json!({ "type": "rename", "name": n }));
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
            // A click at the middle of the visitor's view, where it looks (8.3): to the host, on the control stream.
            "point" => {
                if let Some(v) = self.visiting() {
                    let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "point": clamp_point(&m) })));
                }
            }
            "scene_resync" => {
                let ch = m.get("channel").and_then(Value::as_u64).unwrap_or(0) as u16;
                match self.visits.values().find(|v| v.channel == ch && v.up && v.role == Role::Visitor) {
                    Some(v) => { let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "scene_resync": true }))); }
                    None => self.page_error("no_such_visit", "you are not visiting on that channel", Some("scene_resync")),
                }
            }
            "pose" => {
                let ch = m.get("channel").and_then(Value::as_u64).unwrap_or(0) as u16;
                let state = m.get("state").cloned().unwrap_or(Value::Null);
                match self.visits.values_mut().find(|v| v.channel == ch && v.role == Role::Host) {
                    Some(v) if state.to_string().len() <= 2048 => v.host_state = Some(state),
                    Some(_) => self.page_error("bad_message", "a visitor's state is at most 2 KiB", Some("pose")),
                    None => self.page_error("no_such_visit", "no visit to you on that channel", Some("pose")),
                }
            }
            "keyframe" => {
                let ch = m.get("channel").and_then(Value::as_u64).unwrap_or(0) as u16;
                let Some(v) = self.visits.values().find(|v| v.channel == ch && v.up && v.role == Role::Visitor) else {
                    return self.page_error("no_such_visit", "you are not visiting on that channel", Some(&t));
                };
                let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "keyframe": true })));
            }
            other => {
                let other = other.to_string();
                self.page_error("unknown_type", &format!("no message type {other:?}"), Some(&other));
            }
        }
    }

    /// A delta of this office's scene for one of its visitors, or an edit of it.
    fn page_frame(&mut self, data: &[u8]) {
        if let Some((ch, gz)) = frames::scene_from_page(data) {
            let resync = match self.visits.values().find(|v| v.channel == ch && v.role == Role::Host && v.up) {
                Some(v) => v.cmd.try_send(LinkCmd::Scene(gz)).is_err(),
                None => return debug!(ch, "a scene edit for no visit"),
            };
            if resync {   // the link's queue is full: what follows would build on an edit it never got
                self.to_page(json!({ "type": "scene_resync", "channel": ch }));
            }
            return;
        }
        let Some((ch, frame)) = Frame::from_page(data) else { return debug!(len = data.len(), "a malformed delta from the page") };
        match self.visits.values().find(|v| v.channel == ch && v.role == Role::Host && v.up) {
            Some(v) => {
                if v.cmd.try_send(LinkCmd::Frame(frame)).is_err() {
                    debug!(ch, "the link is not taking deltas");
                }
            }
            None => debug!(ch, "a delta for no visit"),
        }
    }

    fn to_page(&mut self, v: Value) {
        if let Some(p) = &self.page {
            let _ = p.text.send(PageOut::Text(v.to_string()));   // gone: PageClosed follows
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
            if self.saved.away {
                self.page_error("away", "this office is out of the lobby: join_lobby to come back", re.as_deref());
            } else {
                self.page_error("offline", "the lobby is not reachable right now", re.as_deref());
            }
        }
    }

    /// In or out of the lobby, as the page asks. Out: its visits end, its knocks go, the lobby hears bye,
    /// and it stays out (across restarts too, with a state file) until asked back.
    fn set_away(&mut self, away: bool) {
        if away == self.saved.away {
            return;
        }
        self.saved.away = away;
        self.save_state();
        if away {
            info!("leaving the lobby: the page asked");
            self.end_all("gone");
            self.knocks.clear();
            self.lobby_view = None;
            self.online = false;
            let _ = self.lobby.send(LobbyOut::Leave);
        } else {
            info!("joining the lobby again: the page asked");
            let _ = self.lobby.send(LobbyOut::Join);
        }
        self.to_page(json!({ "type": "offline", "away": away }));
    }

    fn save_state(&self) {
        let Some(path) = &self.state_file else { return };
        if let Err(e) = self.saved.save(path) {
            warn!("could not keep this office's state in {}: {e}", path.display());
        }
    }

    fn door(&self) -> &'static str {
        if self.saved.door_open { "open" } else { "closed" }
    }

    fn guests(&self) -> Value {
        json!(self.saved.guests.iter().map(|g| json!({ "key": g.key, "name": g.name })).collect::<Vec<_>>())
    }

    fn tell_guests(&mut self) {
        let (door, guests) = (self.door(), self.guests());
        self.to_page(json!({ "type": "guests", "door": door, "guests": guests }));
    }

    /// Its link to the lobby, so others can visit: only while its page hosts its scene.
    fn publish_link(&mut self) {
        if let (true, true, Some((endpoint, addr))) = (self.online, self.hosting.is_some(), self.link.clone()) {
            let _ = self.lobby.send(LobbyOut::Msg(json!({ "type": "link", "endpoint": endpoint, "addr": addr })));
        }
    }

    /// The page hosts its scene (of this three.js revision), or no longer: the office's link published or
    /// withdrawn (withdrawn, it cannot be visited or knock; visits under way go on).
    fn set_hosting(&mut self, three: Option<String>) {
        let was = self.hosting.is_some();
        self.hosting = three;
        match (was, self.hosting.is_some()) {
            (false, true) => {
                info!(three = self.hosting.as_deref().unwrap_or(""), "the page hosts its scene: in the lobby to be visited");
                self.publish_link();
            }
            (true, false) if self.online => {
                info!("no page hosting: withdrawn from visits until one does");
                let _ = self.lobby.send(LobbyOut::Msg(json!({ "type": "link", "endpoint": null, "addr": null })));
            }
            _ => {}
        }
    }

    async fn lobby_msg(&mut self, m: Value) {
        if self.saved.away {
            return;   // the last words of a session it has left
        }
        let t = m.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        match t.as_str() {
            "welcome" => {
                let resumed = m.get("resumed").and_then(Value::as_bool).unwrap_or(false);
                // The knocks still waiting on this office come again after the welcome.
                self.knocks.clear();
                if !resumed {
                    self.admitted.clear();
                    self.end_all("gone");
                } else if let Some(live) = m.get("visits").and_then(Value::as_array) {
                    // Back after a drop: a visit that ended while this office was away is over (the lobby
                    // lists those it still has; one agreed meanwhile follows as a `visit`).
                    let live: Vec<&str> = live.iter().filter_map(Value::as_str).collect();
                    let over: Vec<String> = self.visits.keys().filter(|id| !live.contains(&id.as_str())).cloned().collect();
                    for id in over {
                        self.end_visit(&id, "gone");
                    }
                }
                self.office = json!({ "id": m.get("id"), "name": m.get("name") });
                self.online = true;
                if self.links.is_none() {
                    let relays = self.relays.take().unwrap_or_else(|| {
                        let urls: Vec<String> = m.get("relays").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
                        if urls.is_empty() { Relays::Default } else { Relays::Custom(urls) }
                    });
                    match Links::start(relays, self.saved.key.clone(), self.me.clone()).await {
                        Ok(l) => self.links = Some(l),
                        Err(e) => warn!("could not start the link endpoint: {e:#}"),
                    }
                }
                info!(office = %self.office, resumed, "in the lobby");
                self.publish_link();
                let (office, knocking) = (self.office.clone(), m.get("knocking").cloned().unwrap_or(json!([])));
                self.to_page(json!({ "type": "online", "office": office, "knocking": knocking }));
            }
            "lobby" => {
                self.lobby_view = Some(m.clone());
                self.to_page(m);
            }
            "knock" => {
                if self.let_guest_in(&m) {
                    return;
                }
                if let Some(id) = m.get("id").and_then(Value::as_str) {
                    self.knocks.insert(id.to_string(), (m.clone(), Instant::now()));
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

    /// A knock from a guest, with the door open and the room hosted: answered yes here, at once, without the
    /// page (which hears the visit start). The knocker's key is the lobby's word until the visit is agreed: then
    /// the visitor's link must be that key (visit_agreed), and the link makes it prove it.
    fn let_guest_in(&mut self, m: &Value) -> bool {
        let from = m.get("from");
        let (Some(kid), Some(fid), Some(fkey)) = (
            m.get("id").and_then(Value::as_str),
            from.and_then(|f| f.get("id")).and_then(Value::as_str),
            from.and_then(|f| f.get("key")).and_then(Value::as_str),
        ) else {
            return false;
        };
        if !self.saved.door_open || self.hosting.is_none() || !self.saved.guests.iter().any(|g| g.key == fkey) {
            return false;
        }
        info!(knock = kid, from = fid, "a guest at the open door: let in");
        self.admitted.insert(fid.to_string(), (fkey.to_string(), Instant::now()));
        let kid = kid.to_string();
        self.to_lobby(json!({ "type": "answer", "knock": kid, "accept": true }));
        true
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
        if self.visits.contains_key(id) {
            return;   // told again after a resume: it is already under way
        }
        let Some(links) = self.links.clone() else {
            return self.to_lobby(json!({ "type": "end", "visit": id, "reason": "link_failed" }));
        };
        let role = if role == "host" { Role::Host } else { Role::Visitor };
        let peer_link = m.get("peer_link").cloned().unwrap_or(Value::Null);
        let endpoint = peer_link.get("endpoint").and_then(Value::as_str).map(str::to_string);
        // The other office, with its key: the link proves it (the host admits only that endpoint; the visitor
        // dials that very one).
        let mut peer = m.get("peer").cloned().unwrap_or(Value::Null);
        if let (Some(p), Some(k)) = (peer.as_object_mut(), &endpoint) {
            p.insert("key".into(), json!(k));
        }
        let mut guest = false;
        if role == Role::Host {
            let pid = peer.get("id").and_then(Value::as_str).unwrap_or("");
            if let Some((key, _)) = self.admitted.remove(pid) {
                if endpoint.as_deref() != Some(key.as_str()) {
                    warn!(visit = id, "a guest let in whose link is another key: ended");
                    return self.to_lobby(json!({ "type": "end", "visit": id, "reason": "kicked" }));
                }
                guest = true;
            }
        }
        let cmd = match role {
            Role::Host => links.host(id, ticket, &peer_link),
            Role::Visitor => links.visitor(id, ticket, &peer_link),
        };
        match cmd {
            Ok(cmd) => {
                let channel = self.channel();
                info!(visit = id, ?role, channel, "visit agreed");
                self.visits.insert(id.to_string(), Visit {
                    id: id.to_string(), channel, role, peer, up: false, cmd,
                    last_seq: 0, inputs: (Instant::now(), 0), want_key: false, host_state: None, ctl: (Instant::now(), 0), key_asked: None, resync_asked: None, resync_due: false,
                    points: (Instant::now(), 0), guest,
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

    /// Visitors' requests for the whole scene that may go to the page now (at most every RESYNC_EVERY each).
    fn resyncs(&mut self) {
        let due: Vec<u16> = self.visits.values_mut()
            .filter(|v| v.resync_due && v.resync_asked.is_none_or(|t| t.elapsed() >= RESYNC_EVERY))
            .map(|v| { v.resync_due = false; v.resync_asked = Some(Instant::now()); v.channel })
            .collect();
        for ch in due {
            self.to_page(json!({ "type": "scene_resync", "channel": ch }));
        }
    }

    /// A control message to every visitor of this office.
    fn tell_hosted(&self, ctl: Value) {
        for v in self.visits.values().filter(|v| v.role == Role::Host && v.up) {
            let _ = v.cmd.try_send(LinkCmd::Ctl(ctl.clone()));
        }
    }

    fn link_up(&mut self, id: &str, first: bool) {
        let has_page = self.page.is_some();
        let Some(v) = self.visits.get_mut(id) else { return };
        v.up = true;
        let (role, cmd) = (v.role, v.cmd.clone());
        let started = started(v);
        match role {
            Role::Visitor => {
                if !first {   // back after a blip: where everything is now
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
        if v.ctl.0.elapsed() >= Duration::from_secs(1) {
            v.ctl = (Instant::now(), 0);
        }
        v.ctl.1 += 1;
        if v.ctl.1 > CTL_PER_SECOND {
            if v.ctl.1 == CTL_PER_SECOND + 1 {
                warn!(visit = id, "the other side sends too many control messages: dropping some");
            }
            return;
        }
        let ch = v.channel;
        match v.role {
            // From the visitor.
            Role::Host => {
                if m.get("scene_resync").is_some() {
                    v.resync_due = true;
                    self.resyncs();
                } else if m.get("keyframe").is_some() && v.key_asked.is_none_or(|t| t.elapsed() >= KEY_EVERY) {
                    v.key_asked = Some(Instant::now());
                    self.to_page(json!({ "type": "keyframe", "channel": ch }));
                } else if let Some(p) = m.get("point") {
                    if v.points.0.elapsed() >= Duration::from_secs(1) {
                        v.points = (Instant::now(), 0);
                    }
                    if v.points.1 < POINTS_PER_SECOND {
                        v.points.1 += 1;
                        let mut p = clamp_point(p);
                        p["type"] = json!("point");
                        p["channel"] = json!(ch);
                        self.to_page(p);
                    }
                }
            }
            // From the host.
            Role::Visitor => {
                if let Some(p) = m.get("paused").and_then(Value::as_bool) {
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
        if v.inputs.1 >= INPUTS_PER_SECOND {
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

    /// A delta of the scene of the room this office is visiting.
    fn link_frame(&mut self, id: &str, frame: Frame) {
        let Some(v) = self.visits.get_mut(id).filter(|v| v.role == Role::Visitor) else { return debug!(id, "a delta for no visit") };
        let Some(page) = &self.page else { return debug!(id, "a delta with no page to show it") };
        if v.want_key && !frame.key {
            return;
        }
        trace!(id, key = frame.key, ts = frame.ts, "delta to the page");
        // A page falling behind loses deltas (its own queue: never its messages), then waits for a key delta.
        if page.frames.try_send(frame.to_page(v.channel)).is_err() {
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
    let mut m = json!({ "type": "visit_started", "id": v.id, "channel": v.channel, "role": if v.role == Role::Host { "host" } else { "visitor" }, "peer": v.peer });
    if let Some(state) = &v.host_state {
        m["state"] = state.clone();
    }
    if v.guest {
        m["guest"] = json!(true);
    }
    m
}

/// A point (8.3): where the visitor looked as it clicked, `yaw` and `pitch` in the same terms as its input, each
/// in its range; nothing else of what was sent passes.
fn clamp_point(m: &Value) -> Value {
    let angle = |k: &str, lim: f64| m.get(k).and_then(Value::as_f64).filter(|x| x.is_finite()).map_or(0.0, |x| x.clamp(-lim, lim));
    json!({ "yaw": angle("yaw", 1e6), "pitch": angle("pitch", 1.4) })
}

/// A three.js revision, as `THREE.REVISION` says it: digits.
fn revision(r: &str) -> bool {
    (1..=4).contains(&r.len()) && r.bytes().all(|b| b.is_ascii_digit())
}

/// An input with every field in its range (../SPEC.md section 8.2). `t` (the visitor page's clock when it
/// sent it, ms) passes through as a number, for the host to echo in its deltas.
fn clamp_input(m: &Value) -> Value {
    let step = |k: &str| m.get(k).and_then(Value::as_f64).filter(|x| x.is_finite()).map_or(0, |x| x.round().clamp(-1.0, 1.0) as i64);
    let angle = |k: &str, lim: f64| m.get(k).and_then(Value::as_f64).filter(|x| x.is_finite()).map_or(0.0, |x| x.clamp(-lim, lim));
    json!({
        "forward": step("forward"), "strafe": step("strafe"), "run": m.get("run").and_then(Value::as_bool).unwrap_or(false),
        "yaw": angle("yaw", 1e6), "pitch": angle("pitch", 1.4),
        "t": m.get("t").and_then(Value::as_f64).filter(|x| x.is_finite()).map_or(0.0, |x| x.clamp(0.0, 1e12)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revisions_are_digits() {
        assert!(revision("128") && revision("186"));
        assert!(!revision("r128") && !revision("") && !revision("12345") && !revision("1.2"));
    }

    #[test]
    fn inputs_are_clamped() {
        let i = clamp_input(&json!({ "forward": 5, "strafe": -0.6, "run": "yes", "yaw": 3.0, "pitch": -9 }));
        assert_eq!(i, json!({ "forward": 1, "strafe": -1, "run": false, "yaw": 3.0, "pitch": -1.4, "t": 0.0 }));
        let j = clamp_input(&json!({ "t": 1234.5 }));
        assert_eq!(j, json!({ "forward": 0, "strafe": 0, "run": false, "yaw": 0.0, "pitch": 0.0, "t": 1234.5 }));
    }

    #[test]
    fn points_are_clamped_and_bare() {
        let p = clamp_point(&json!({ "type": "point", "yaw": 2.5, "pitch": 9, "target": "the front door", "channel": 3 }));
        assert_eq!(p, json!({ "yaw": 2.5, "pitch": 1.4 }));
        assert_eq!(clamp_point(&json!({ "yaw": "left", "pitch": null })), json!({ "yaw": 0.0, "pitch": 0.0 }));
    }
}
