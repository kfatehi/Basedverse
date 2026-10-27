//! The visit-client's core: one task owns all its state (the office, the lobby as last seen, the knocks
//! on its door, the visits) and routes what comes in from the page, the lobby and the links (../SPEC.md
//! sections 4-8). Everything else talks to it through `Ev`s.
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    path::PathBuf,
    time::{Duration, Instant},
};

use bytes::Bytes;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tracing::{debug, info, trace, warn};

use crate::{
    frames::{self, Frame},
    land::{self, Kept, Lands},
    link::{self, LinkCmd, Links, Relays, Role},
    lobby::LobbyOut,
    state::{self, Guest, Place, Saved},
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
    /// A visitor's avatar (8.6): unpacked, checked JSON, for the host's page.
    LinkAvatar { visit: String, json: String },
    /// One of a visitor's possessions' models (8.11): its id, and unpacked, checked JSON, for the host's page.
    LinkPossession { visit: String, id: String, json: String },
    /// A host's landscape this office asked for, gzipped (../SPEC.md 8.10).
    LinkLand { visit: String, gz: Bytes },
    /// A packet of the other side's voice (8.7).
    LinkAudio { visit: String, data: Bytes },
    /// Someone's voice the other side passed on (8.7, 8.8).
    LinkRelay { visit: String, data: Bytes },
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
    /// A watch (../WORLD.md): the visitor sees the host's plot from outside it, until it steps in (`inside`).
    watch: bool,
    /// The visitor is in the host's room: its input and points count, and the host has it. Always, for a visit;
    /// for a watch, from `enter` to `exit`.
    inside: bool,
    /// The visitor's page reads an added object that names the geometries and materials it already has by uuid
    /// only (8.3; Visit 0.7 on): its visit-client says so when the link is up (host side).
    shared_adds: bool,
    /// A link (8.5): a watch begun by a knock its host let in, not by the world. The door and the guest list do
    /// not end it, nor does the world going off: it ends as a visit does.
    link: bool,
    /// Where the page put a link (visitor side): in its world, kept for a page that reloads.
    in_world: bool,
    /// The host asked for this office's avatar (visitor side): it goes now, and again when the page gives a new one.
    avatar_asked: bool,
    /// The possessions whose models the host asked for (visitor side, 8.11): each goes now, and again when the page
    /// gives a new one. The visitor's possessions, as it last said (host side): for a page that reloads.
    possessions_asked: Vec<String>,
    peer_possessions: Value,
    /// The other office's room has a phone (8.8): it takes calls.
    peer_phone: bool,
    /// A call is on over this link (answered, one way or the other, and not hung up), and this office has it on
    /// its phone's speaker (8.8; else to the ear).
    call_on: bool,
    speaker: bool,
    /// Lines said by the visitor in the current window (host side): at most SAYS a SAY_WINDOW.
    says: (Instant, u32),
    /// Landscapes (8.10). Host side: the visitor reads them (else its page gets the whole room inline), and the
    /// one last sent it. Visitor side: the host's, by its hash.
    landscapes: bool,
    land_sent: Option<String>,
    land_hash: Option<String>,
}

/// Where everyone in this office's room is (8.7), in metres, as its page last said: its own user (none while they
/// are elsewhere, or the page has not said), its phone, and each visitor in it, by channel. Who hears whom in the
/// room goes by it: the room moves its visitors, so it is the room's word, not theirs.
#[derive(Default)]
struct VoiceRoom {
    me: Option<[f64; 3]>,
    phone: Option<[f64; 3]>,
    visitors: HashMap<u16, [f64; 3]>,
    /// Who each was last told is near it (by channel; 0, this office's page), and when.
    told: HashMap<u16, (Value, Instant)>,
}

/// The most control messages a link's other side may send a second; more are dropped (a peer flooding
/// requests must not swamp this office's page).
const CTL_PER_SECOND: u32 = 20;
const KEY_EVERY: Duration = Duration::from_millis(500);
const RESYNC_EVERY: Duration = Duration::from_secs(2);
/// The most inputs a second taken from a visitor (it sends one whenever its keys or look change, at most
/// every 8 ms, and every 33 ms regardless).
const INPUTS_PER_SECOND: u32 = 120;
/// Voice (8.7): heard within VOICE_RANGE metres of whoever speaks, in the same room, fading to nothing there; sent
/// VOICE_MARGIN farther, so a voice fades in rather than starts. Who is near whom: told when that changes, and
/// their distances at most every NEAR_EVERY.
const VOICE_RANGE: f64 = 45.0;
const VOICE_MARGIN: f64 = 15.0;
const NEAR_EVERY: Duration = Duration::from_secs(1);
/// Chat (8.9): a line said is at most SAY_LEN characters; each office says at most SAYS lines a SAY_WINDOW (its
/// page, and each visitor in its room, apart).
const SAY_LEN: usize = 200;
const SAYS: u32 = 5;
const SAY_WINDOW: Duration = Duration::from_secs(10);
/// The most points a second taken from a visitor (a click at the middle of its view: 8.3); more are dropped.
/// Its page sends at most one every 200 ms.
const POINTS_PER_SECOND: u32 = 5;
/// How long a guest let in through the open door is waited for, to be agreed as a visit by the lobby.
const ADMITTED_FOR: Duration = Duration::from_secs(120);
/// The world (../WORLD.md): a knock to watch a guest's plot not yet answered is not made again for this long;
/// one declined (or refused by the lobby), for this long.
const WATCH_PENDING: Duration = Duration::from_secs(15);
const WATCH_DECLINED: Duration = Duration::from_secs(20);
/// The most plots an office watches at once (the lobby's own limit is the same).
const MAX_WATCHING: usize = 8;
/// With no page for this long, its world's watches end (they are only for a page to draw); a new page that has
/// not asked for the world this long after connecting, the same.
const WORLD_NO_PAGE: Duration = Duration::from_secs(60);
const WORLD_ASK: Duration = Duration::from_secs(10);

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
    /// The lobby relays chat (8.9: its welcome said so): this office's page may say a line to everyone there.
    lobby_chat: bool,
    /// What outlasts a run, kept in `state_file`: whether the page took this office out of the lobby
    /// (leave_lobby, until join_lobby), its key, its door and its guests.
    saved: Saved,
    state_file: Option<PathBuf>,
    /// The office's key, as others see it: its link endpoint's public key.
    key: String,
    /// Guests let in through the open door (knocker's office id -> its key, and when), until the lobby agrees
    /// their visit: then the visitor's link must be that key.
    admitted: HashMap<String, (String, Instant)>,
    /// The page draws a world (../WORLD.md): this office watches its guests' plots, by itself. After a page
    /// connects, until it asks for the world again (or WORLD_ASK passes, and the world goes off).
    world: bool,
    world_ask: Option<Instant>,
    /// Knocks to watch: sent (office id -> when, and in the order sent: the lobby answers each, in order, with
    /// knock_sent or an error), sent and named by the lobby (knock id -> office id), and declined or refused
    /// (key -> when): not made again for a while.
    watch_pending: HashMap<String, Instant>,
    watch_order: VecDeque<String>,
    watch_knocks: HashMap<String, String>,
    watch_declined: HashMap<String, Instant>,
    office: Value,
    status: String,
    max_visitors: u8,
    lobby_view: Option<Value>,
    /// This office's own avatar, gzipped JSON (8.6), as its page last gave it: for the hosts that ask.
    avatar: Option<Bytes>,
    /// This office's own possessions (8.11), as its page last gave them: what each is (every host it visits is
    /// told), and its model, gzipped JSON, for the hosts that ask.
    possessions: Vec<(Value, Option<Bytes>)>,
    /// This office's room has a phone (8.8), as its page said: every link is told.
    phone: bool,
    /// Where everyone in this office's room is, for its voice (8.7).
    voice: VoiceRoom,
    /// Lines this office's page said in the current window (8.9).
    says: (Instant, u32),
    /// This office's own landscape (8.10), as its page last gave it: its hash, and it gzipped. And friends' kept.
    land: Option<(String, Bytes)>,
    lands: Lands,
    /// Where this office's page has put others in its world (8.4), by key: each told over every link up with it.
    seen_out: HashMap<String, Value>,
    /// Where others have put this office in their worlds, by key: (their name, where), for a page that comes back;
    /// forgotten with the last link to them.
    seen_in: HashMap<String, (Value, Value)>,
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
               saved: Saved, fresh: bool, state_file: Option<PathBuf>, lands: Lands) -> Core {
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
            lobby_chat: false,
            saved,
            state_file,
            key,
            admitted: HashMap::new(),
            world: false,
            world_ask: None,
            watch_pending: HashMap::new(),
            watch_order: VecDeque::new(),
            watch_knocks: HashMap::new(),
            watch_declined: HashMap::new(),
            office: Value::Null,
            status: "available".into(),
            max_visitors,
            lobby_view: None,
            avatar: None,
            possessions: Vec::new(),
            phone: false,
            voice: VoiceRoom::default(),
            says: (Instant::now(), 0),
            land: None,
            lands,
            seen_out: HashMap::new(),
            seen_in: HashMap::new(),
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
                    if self.world && self.page.is_none() && self.page_gone.elapsed() >= WORLD_NO_PAGE {
                        info!("no page for a minute: its world's watches end");
                        self.set_world(false);
                    }
                    if self.world && self.page.is_some() && self.world_ask.is_some_and(|t| t.elapsed() >= WORLD_ASK) {
                        info!("the page does not draw a world: its watches end");
                        self.set_world(false);
                    }
                    self.watch_guests();
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
                    self.set_phone(false);    // nor a phone to answer: the other side's calls end
                    self.voice = VoiceRoom { told: std::mem::take(&mut self.voice.told), ..VoiceRoom::default() };   // nobody here to hear
                    self.tell_near();
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
            Ev::LinkLand { visit, gz } => self.land_in(&visit, gz),
            Ev::LinkAudio { visit, data } => self.voice_in(&visit, data, false),
            Ev::LinkRelay { visit, data } => self.voice_in(&visit, data, true),
            Ev::LinkPossession { visit, id, json } => {
                if let Some(v) = self.visits.get(&visit).filter(|v| v.role == Role::Host) {
                    // Already checked JSON: wrapped as it is, not parsed again (the id was checked as it came).
                    let msg = format!("{{\"type\":\"possession\",\"channel\":{},\"id\":{},\"possession\":{json}}}", v.channel, json!(id));
                    if let Some(p) = &self.page {
                        let _ = p.text.send(PageOut::Text(msg));
                    }
                }
            }
            Ev::LinkAvatar { visit, json } => {
                if let Some(v) = self.visits.get(&visit).filter(|v| v.role == Role::Host) {
                    // Already checked JSON: wrapped as it is, not parsed again.
                    let msg = format!("{{\"type\":\"avatar\",\"channel\":{},\"avatar\":{json}}}", v.channel);
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
        self.world_ask = self.world.then(Instant::now);   // the world goes on only if this page asks for it too
        let visits: Vec<Value> = self.visits.values().filter(|v| v.up).map(started).collect();
        self.to_page(json!({
            "type": "ready", "version": VERSION, "office": self.office, "online": self.online, "lobby_chat": self.lobby_chat, "away": self.saved.away, "status": self.status,
            "max_visitors": self.max_visitors, "visits": visits, "key": self.key, "door": self.door(), "guests": self.guests(),
            "layout": self.saved.layout_json(), "avatars": self.saved.avatars_json(), "voice_range": VOICE_RANGE, "kept": self.lands.kept_json(),
            "seen": self.seen_in.iter().map(|(k, (name, at))| json!({ "key": k, "name": name, "at": at })).collect::<Vec<_>>(),
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
        // A visit this page is on: the host's whole scene again (a page that comes back has none), and a key delta;
        // and its landscape, kept here (8.10).
        let mut lands = Vec::new();
        for v in self.visits.values().filter(|v| v.up && v.role == Role::Visitor) {
            let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "scene_resync": true })));
            let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "keyframe": true })));
            if let (Some(h), Some(key)) = (&v.land_hash, v.peer.get("key").and_then(Value::as_str)) {
                lands.push((v.channel, key.to_string(), h.clone()));
            }
        }
        for (ch, key, h) in lands {
            if let Some(gz) = self.lands.get(&key, &h) {
                self.land_to_page(ch, &key, gz);
            }
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
                    if !open {
                        self.end_watchers(|_| true);   // the door shut: no guest watches this plot any more
                    }
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
                    let k = k.to_string();
                    self.saved.guests.retain(|g| g.key != k);
                    self.save_state();
                    self.tell_guests();
                    self.end_watchers(|key| key == k);   // no longer a guest: no longer watching
                    self.forget_plot(&k);   // nor kept in this world while they are away
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
                let mut m = m;
                if t == "answer" {   // answered: no longer waiting, so not shown again to a page that reconnects
                    if let Some(k) = m.get("knock").and_then(Value::as_str) {
                        self.knocks.remove(k);
                    }
                } else if let Some(o) = m.as_object_mut() {
                    o.remove("watch");   // a page knocks to visit; watching is this visit-client's own (world)
                }
                self.to_lobby(m);
            }
            // The world (../WORLD.md): this office watches its guests' plots for its page to draw, steps into one
            // (`enter`, where in its own terms) and out again.
            "world" => match m.get("on").and_then(Value::as_bool) {
                Some(on) => self.set_world(on),
                None => self.page_error("bad_message", "on must be true or false", Some("world")),
            },
            "enter" => {
                let ch = m.get("channel").and_then(Value::as_u64).unwrap_or(0) as u16;
                let Some(id) = self.visits.values().find(|v| v.channel == ch && v.up && v.role == Role::Visitor && v.watch).map(|v| v.id.clone()) else {
                    return self.page_error("no_such_visit", "you are not watching on that channel", Some("enter"));
                };
                // In one room at a time: out of any other first (a visit there ends, as moving rooms ends one).
                let others: Vec<(String, bool)> = self.visits.values().filter(|v| v.role == Role::Visitor && v.inside && v.id != id).map(|v| (v.id.clone(), v.watch)).collect();
                for (other, watch) in others {
                    if watch {
                        self.step_out(&other);
                    } else {
                        self.to_lobby(json!({ "type": "end", "visit": other }));
                    }
                }
                // Where it steps in, in the room's terms; none (a link's "go there"): where the room puts newcomers.
                let pose = m.get("pose").filter(|p| p.is_object()).map(clamp_pose).unwrap_or(Value::Null);
                if let Some(v) = self.visits.get_mut(&id) {
                    v.inside = true;
                    let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "enter": pose })));
                }
            }
            // Where this office has put a friend's plot in its world (kept in the state file).
            "place" => match state::place_from(&m) {
                Some(p) => {
                    let full = self.saved.layout.len() >= state::MAX_PLACES;
                    match self.saved.layout.iter_mut().find(|x| x.key == p.key) {
                        Some(x) => *x = p,
                        None if full => return self.page_error("too_many", &format!("at most {} places", state::MAX_PLACES), Some("place")),
                        None => self.saved.layout.push(p),
                    }
                    self.save_state();
                    self.tell_layout();
                }
                None => self.page_error("bad_message", "place needs a key, x and z (numbers) and turn (0-3)", Some("place")),
            },
            "unplace" => {
                let k = m.get("key").and_then(Value::as_str).unwrap_or("");
                self.saved.layout.retain(|p: &Place| p.key != k);
                self.save_state();
                self.tell_layout();
            }
            // Where this page has put an office in its world, beside its own room (8.4): told to that office alone, over
            // a link with it either way (it sees where it is in your world, and nothing else of it); null: not in it.
            "seen" => {
                let Some(key) = m.get("key").and_then(Value::as_str).filter(|k| state::key_ok(k)).map(str::to_string) else {
                    return self.page_error("bad_message", "key is an office's key", Some("seen"));
                };
                let seen = match m.get("at").filter(|a| !a.is_null()).map(seen_from) {
                    Some(Some(s)) => s,
                    Some(None) => return self.page_error("bad_message", "at is { dx, dz (m, within 100 km), turn (0-3), size ([w, d] m) } or null", Some("seen")),
                    None => Value::Null,
                };
                if seen.is_null() {
                    self.seen_out.remove(&key);
                } else if self.seen_out.len() >= state::MAX_PLACES && !self.seen_out.contains_key(&key) {
                    return self.page_error("too_many", &format!("at most {} offices", state::MAX_PLACES), Some("seen"));
                } else {
                    self.seen_out.insert(key.clone(), seen.clone());
                }
                self.to_peer(&key, json!({ "seen": seen }));   // with no link now, the next one tells them
            }
            // Avatars (8.6). The page's own (its frame, or `avatar_clear`): kept in memory, to go to hosts that ask. A
            // host's page asks for a visitor's (`avatar_want`). Whose look visitors have here (`avatars`: by default;
            // `avatar_use`: for a key, or back to the default): kept in the state file.
            "avatar_clear" => self.avatar = None,
            // Possessions (8.11): what this office's user owns and brings along (Visit's own are not said: every Visit
            // has them). Every host it visits is told what they are; a host's page asks for one's model
            // (`possession_want`), which goes as it came, its frame (by its slot in this list).
            "possessions" => match possessions_from(m.get("list")) {
                Some(list) => {
                    let old = std::mem::take(&mut self.possessions);
                    self.possessions = list.into_iter().map(|p| {
                        let gz = old.iter().find(|(o, _)| o["id"] == p["id"]).and_then(|(_, gz)| gz.clone());
                        (p, gz)
                    }).collect();
                    let said = json!({ "possessions": self.possessions.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>() });
                    for v in self.visits.values().filter(|v| v.role == Role::Visitor && v.up) {
                        let _ = v.cmd.try_send(LinkCmd::Ctl(said.clone()));
                    }
                }
                None => self.page_error("bad_message", &format!("list is at most {MAX_POSSESSIONS} possessions: {{ id, name, mount, fly, speed, lift }}"), Some("possessions")),
            },
            "possession_want" => {
                let ch = m.get("channel").and_then(Value::as_u64).unwrap_or(0) as u16;
                let Some(id) = m.get("id").and_then(Value::as_str).filter(|id| link::possession_id_ok(id)) else {
                    return self.page_error("bad_message", "id is a possession's", Some("possession_want"));
                };
                match self.visits.values().find(|v| v.channel == ch && v.role == Role::Host && v.up) {
                    Some(v) => { let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "possession_want": id }))); }
                    None => self.page_error("no_such_visit", "no visit to you on that channel", Some("possession_want")),
                }
            }
            // A phone (8.8): this room has one (or not), and a call on one of its visits: ring, answer, hang up.
            "phone" => match m.get("on").and_then(Value::as_bool) {
                Some(on) => self.set_phone(on),
                None => self.page_error("bad_message", "on must be true or false", Some("phone")),
            },
            "call" => {
                let ch = m.get("channel").and_then(Value::as_u64).unwrap_or(0) as u16;
                let Some(act) = m.get("act").and_then(Value::as_str).filter(|a| ["ring", "answer", "hangup"].contains(a)).map(str::to_string) else {
                    return self.page_error("bad_message", "act is \"ring\", \"answer\" or \"hangup\"", Some("call"));
                };
                match self.visits.values_mut().find(|v| v.channel == ch && v.up) {
                    Some(v) if v.peer_phone || act != "ring" => {   // only ringing needs their phone
                        let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "call": act })));
                        call_state(v, &act);
                    }
                    Some(_) => return self.page_error("no_phone", "their room has no phone", Some("call")),
                    None => return self.page_error("no_such_visit", "no visit on that channel", Some("call")),
                }
                self.tell_near();
            }
            // A call on this office's phone's speaker (everyone near the phone hears it, and is heard in it), or back
            // to the ear (8.8).
            "speaker" => {
                let ch = m.get("channel").and_then(Value::as_u64).unwrap_or(0) as u16;
                let Some(on) = m.get("on").and_then(Value::as_bool) else {
                    return self.page_error("bad_message", "on must be true or false", Some("speaker"));
                };
                match self.visits.values_mut().find(|v| v.channel == ch && v.up && v.call_on) {
                    Some(v) => v.speaker = on,
                    None => return self.page_error("no_call", "no call on that channel", Some("speaker")),
                }
                self.tell_near();
            }
            // A friend's plot in this office's world, kept to draw while they are away (8.10): who, where its plot is
            // (in its terms), its unit. Drawn from its last landscape (`plot_load`: sent as `landscape`, channel 0);
            // let go (`plot_forget`) as the page says.
            "plot_keep" => match Kept::from_json(&m) {
                Some(k) => self.lands.keep_plot(k),
                None => self.page_error("bad_message", "key, name, plot { center, size }, unit", Some("plot_keep")),
            },
            "plot_load" => {
                let key = m.get("key").and_then(Value::as_str).unwrap_or("").to_string();
                match self.lands.latest(&key).filter(|_| self.lands.is_kept(&key)) {
                    Some(gz) => self.land_to_page(0, &key, gz),
                    None => self.page_error("not_found", "no plot kept for that key", Some("plot_load")),
                }
            }
            "plot_forget" => {
                let key = m.get("key").and_then(Value::as_str).unwrap_or("").to_string();
                self.forget_plot(&key);
            }
            // A line this office's user says (8.9): to everyone in the room they are in, and nobody else.
            // Where it goes (`to`): none (or "here"), everyone who can see this office's user (the room they are in, and
            // those who have it in their worlds or corners); { key }, into a linked office's room; { whisper }, to the
            // user of the office with that id alone, through the lobby; "lobby", everyone in the lobby.
            "say" => {
                let Some(text) = m.get("text").and_then(Value::as_str).and_then(said) else {
                    return self.page_error("bad_message", &format!("text is 1 to {SAY_LEN} characters"), Some("say"));
                };
                let to = m.get("to").filter(|t| !t.is_null() && t.as_str() != Some("here"));
                let lobby = to.and_then(Value::as_str) == Some("lobby");
                let key = to.and_then(|t| t.get("key")).and_then(Value::as_str).filter(|k| state::key_ok(k)).map(str::to_string);
                let whisper = to.and_then(|t| t.get("whisper")).and_then(Value::as_str).filter(|id| !id.is_empty() && id.len() <= 40).map(str::to_string);
                if to.is_some() && !lobby && key.is_none() && whisper.is_none() {
                    return self.page_error("bad_message", "to is \"here\", \"lobby\", { key } of an office linked with this one, or { whisper } an office's id", Some("say"));
                }
                if (lobby || whisper.is_some()) && !(self.online && self.lobby_chat) {
                    return self.page_error("not_supported", "this lobby takes no chat (or this office is not in it)", Some("say"));
                }
                if let Some(k) = &key {
                    if !self.visits.values().any(|v| v.up && v.peer.get("key").and_then(Value::as_str) == Some(k.as_str())) {
                        return self.page_error("no_link", "no link with that office, either way", Some("say"));
                    }
                }
                if !counted(&mut self.says) {
                    return self.page_error("rate_limited", &format!("at most {SAYS} lines every {} s", SAY_WINDOW.as_secs()), Some("say"));
                }
                if let Some(id) = whisper {
                    self.to_lobby(json!({ "type": "whisper", "to": id, "text": text }));
                } else if let Some(k) = key {
                    self.to_peer(&k, json!({ "sim_say": text }));
                } else if lobby {
                    self.to_lobby(json!({ "type": "chat", "text": text }));
                } else {
                    self.say_out(text);
                }
            }
            // Where everyone in this office's room is (8.7), in metres, as its page has them: its own user (null:
            // elsewhere), its phone, and each visitor in it ([channel, x, y, z]). Who hears whom here goes by it.
            "voice_where" => {
                self.voice.me = spot(m.get("me"));
                self.voice.phone = spot(m.get("phone"));
                self.voice.visitors = m.get("visitors").and_then(Value::as_array).into_iter().flatten().take(256).filter_map(|e| {
                    let a = e.as_array().filter(|a| a.len() == 4)?;
                    Some((u16::try_from(a[0].as_u64()?).ok()?, spot(Some(&json!(a[1..])))?))
                }).collect();
                self.tell_near();
            }
            "avatar_want" => {
                let ch = m.get("channel").and_then(Value::as_u64).unwrap_or(0) as u16;
                match self.visits.values().find(|v| v.channel == ch && v.role == Role::Host && v.up) {
                    Some(v) => { let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "avatar_want": true }))); }
                    None => self.page_error("no_such_visit", "no visit to you on that channel", Some("avatar_want")),
                }
            }
            "avatars" => match state::use_from(m.get("default")) {
                Some(theirs) => {
                    self.saved.avatars_theirs = theirs;
                    self.saved.avatars_set = true;
                    self.saved.avatars_by.retain(|(_, t)| *t != theirs);   // the same as the default now: no longer apart
                    self.save_state();
                    self.tell_avatars();
                }
                None => self.page_error("bad_message", "default is \"mine\" or \"theirs\"", Some("avatars")),
            },
            "avatar_use" => {
                let Some(key) = m.get("key").and_then(Value::as_str).filter(|k| state::key_ok(k)).map(str::to_string) else {
                    return self.page_error("bad_message", "key is an office's key", Some("avatar_use"));
                };
                let use_ = state::use_from(m.get("use"));
                if use_.is_none() && !m.get("use").is_none_or(Value::is_null) {
                    return self.page_error("bad_message", "use is \"mine\", \"theirs\" or null (the default)", Some("avatar_use"));
                }
                self.saved.avatars_by.retain(|(k, _)| *k != key);
                if let Some(theirs) = use_.filter(|t| *t != self.saved.avatars_theirs) {
                    if self.saved.avatars_by.len() >= state::MAX_GUESTS {
                        return self.page_error("too_many", &format!("at most {} apart", state::MAX_GUESTS), Some("avatar_use"));
                    }
                    self.saved.avatars_by.push((key, theirs));
                }
                self.save_state();
                self.tell_avatars();
            }
            // Where the page put a link: its world, or the corner (kept for a page that reloads: visit_started says).
            "link_where" => {
                let ch = m.get("channel").and_then(Value::as_u64).unwrap_or(0) as u16;
                let world = match m.get("where").and_then(Value::as_str) {
                    Some("world") => true,
                    Some("corner") => false,
                    _ => return self.page_error("bad_message", "where is \"world\" or \"corner\"", Some("link_where")),
                };
                match self.visits.values_mut().find(|v| v.channel == ch && v.role == Role::Visitor && v.link) {
                    Some(v) => v.in_world = world,
                    None => self.page_error("no_such_visit", "no link of yours on that channel", Some("link_where")),
                }
            }
            "exit" => {
                let ch = m.get("channel").and_then(Value::as_u64).unwrap_or(0) as u16;
                match self.visits.values().find(|v| v.channel == ch && v.role == Role::Visitor && v.watch).map(|v| v.id.clone()) {
                    Some(id) => self.step_out(&id),
                    None => self.page_error("no_such_visit", "you are not watching on that channel", Some("exit")),
                }
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
        if let Some(gz) = frames::land_from_page(data) {   // this room's landscape: kept, and offered by its hash to every visitor
            return self.land_set(gz);
        }
        if let Some((to, audio)) = frames::audio_from_page(data) {   // this office's user's voice: this visit-client decides who hears it
            return self.voice_out(to, audio);
        }
        if let Some((slot, gz)) = frames::possession_from_page(data) {   // a possession's model: to every host that asked for it
            let Some((p, kept)) = self.possessions.get_mut(slot as usize) else { return };
            let id = p["id"].as_str().unwrap_or("").to_string();
            *kept = Some(gz.clone());
            for v in self.visits.values().filter(|v| v.role == Role::Visitor && v.up && v.possessions_asked.contains(&id)) {
                let _ = v.cmd.try_send(LinkCmd::Possession(id.clone(), gz.clone()));
            }
            return;
        }
        if let Some(gz) = frames::avatar_from_page(data) {   // this office's avatar: to every host that asked for it
            for v in self.visits.values().filter(|v| v.role == Role::Visitor && v.up && v.avatar_asked) {
                let _ = v.cmd.try_send(LinkCmd::Avatar(gz.clone()));
            }
            self.avatar = Some(gz);
            return;
        }
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

    fn tell_layout(&mut self) {
        let layout = self.saved.layout_json();
        self.to_page(json!({ "type": "layout", "layout": layout }));
    }

    // ---------- voice (8.7) and phones (8.8): who hears whom in this office's room, decided here ----------

    /// This office's user's voice, from its page, where it may go (`allowed`: the room, their calls): to the room
    /// they are in (another's: to its owner, whose visit-client decides; their own: to each visitor near them), and
    /// to a call (to the ear, always; on speaker, if they are near the phone).
    fn voice_out(&mut self, allowed: u16, voice: Bytes) {
        let away = self.visits.values().find(|v| v.up && v.role == Role::Visitor && v.inside).map(|v| v.channel);
        let me = if away.is_some() { None } else { self.voice.me };
        let mut to: Vec<u16> = Vec::new();
        if allowed & frames::VOICE_ROOM != 0 {
            to.extend(away);
            if let Some(me) = me {
                to.extend(self.within(me, VOICE_RANGE + VOICE_MARGIN, None));
            }
        }
        if allowed & frames::VOICE_CALLS != 0 {
            let by_phone = me.zip(self.voice.phone).is_some_and(|(me, p)| flat(me, p) <= VOICE_RANGE);
            to.extend(self.visits.values().filter(|v| v.up && v.call_on && (!v.speaker || by_phone)).map(|v| v.channel));
        }
        to.sort_unstable();
        to.dedup();
        for v in self.visits.values().filter(|v| v.up && to.contains(&v.channel)) {
            let _ = v.cmd.try_send(LinkCmd::Audio(voice.clone()));
        }
    }

    /// A packet of voice over a link (`relayed`: someone else's, passed on, with who spoke). A call's: to the page;
    /// on speaker, also to this room's visitors near the phone, as the phone's. A visitor's in this room: to the
    /// page if this office's user is near them, to the other visitors near them, and to a call on speaker if they
    /// are near the phone. The room this office's user is in: to the page (its owner decided). Else nowhere.
    fn voice_in(&mut self, id: &str, data: Bytes, relayed: bool) {
        let Some(v) = self.visits.get(id).filter(|v| v.up) else { return };
        let (ch, role, inside, call_on, speaker, visit) = (v.channel, v.role, v.inside, v.call_on, v.speaker, v.id.clone());
        let name = v.peer.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        if call_on {
            self.voice_to_page(ch, &data, relayed);
            if let Some(phone) = self.voice.phone.filter(|_| speaker) {
                let head = if relayed {
                    let Some((who, said, voice)) = frames::relay_parts(&data) else { return };
                    frames::relay_head(&format!("phone:{who}"), &said, voice)
                } else {
                    frames::relay_head("phone", &name, &data)
                };
                self.relay_to(&self.within(phone, VOICE_RANGE + VOICE_MARGIN, Some(ch)), head);
            }
            return;
        }
        match role {
            Role::Visitor if inside => self.voice_to_page(ch, &data, relayed),
            Role::Host if inside && !relayed => {
                let Some(at) = self.voice.visitors.get(&ch).copied() else { return };   // where the room has them: not said yet, nobody hears
                if self.voice.me.is_some_and(|me| flat(me, at) <= VOICE_RANGE + VOICE_MARGIN) {
                    self.voice_to_page(ch, &data, false);
                }
                let mut to = self.within(at, VOICE_RANGE + VOICE_MARGIN, Some(ch));
                if self.voice.phone.is_some_and(|p| flat(p, at) <= VOICE_RANGE) {   // a call on speaker hears those near the phone
                    to.extend(self.visits.values().filter(|c| c.up && c.call_on && c.speaker && c.channel != ch).map(|c| c.channel));
                }
                self.relay_to(&to, frames::relay_head(&visit, &name, &data));
            }
            _ => {}
        }
    }

    fn voice_to_page(&self, ch: u16, data: &[u8], relayed: bool) {
        if let Some(p) = &self.page {   // a page behind loses some: late is lost
            let _ = p.frames.try_send(if relayed { frames::relay_to_page(ch, data) } else { frames::audio_to_page(ch, data) });
        }
    }

    fn relay_to(&self, channels: &[u16], head: Bytes) {
        for v in self.visits.values().filter(|v| v.up && channels.contains(&v.channel)) {
            let _ = v.cmd.try_send(LinkCmd::Relay(head.clone()));
        }
    }

    /// The channels of this room's visitors within `reach` metres of a spot (as the room has them), but one.
    fn within(&self, at: [f64; 3], reach: f64, but: Option<u16>) -> Vec<u16> {
        self.visits.values().filter(|v| v.up && v.role == Role::Host && v.inside && Some(v.channel) != but)
            .filter(|v| self.voice.visitors.get(&v.channel).is_some_and(|p| flat(*p, at) <= reach))
            .map(|v| v.channel).collect()
    }

    /// Who is near whom in this room (within VOICE_RANGE), for each to know: this office's page (`voice_near`)
    /// and each visitor in it (`near`, over its link); with a call on speaker, its caller for those near the
    /// phone. Told when it changes; their distances, at most every NEAR_EVERY.
    fn tell_near(&mut self) {
        let me_entry = json!({ "key": self.key, "name": self.office.get("name").cloned().unwrap_or(Value::Null) });
        let mut people: Vec<(u16, [f64; 3], Value)> = self.voice.me.map(|me| (0, me, me_entry)).into_iter().collect();
        for v in self.visits.values().filter(|v| v.up && v.role == Role::Host && v.inside) {
            if let Some(at) = self.voice.visitors.get(&v.channel) {
                people.push((v.channel, *at, json!({ "key": v.peer.get("key"), "name": v.peer.get("name"), "id": v.id })));
            }
        }
        let caller = self.visits.values().find(|v| v.up && v.call_on && v.speaker).map(|v| v.peer.get("name").cloned().unwrap_or(Value::Null));
        let mut lists: Vec<(u16, Vec<Value>)> = Vec::new();
        for (ch, at, _) in &people {
            let mut near: Vec<Value> = people.iter().filter(|(o, p, _)| o != ch && flat(*p, *at) <= VOICE_RANGE).map(|(_, p, e)| {
                let mut e = e.clone();
                e["distance"] = json!(flat(*p, *at).round());
                e
            }).collect();
            if let (Some(name), Some(phone), true) = (&caller, self.voice.phone, *ch != 0) {
                if flat(phone, *at) <= VOICE_RANGE {
                    near.push(json!({ "key": "phone", "name": name, "phone": true, "distance": flat(phone, *at).round() }));
                }
            }
            lists.push((*ch, near));
        }
        for ch in self.voice.told.keys().copied().collect::<Vec<_>>() {   // no longer in the room (or not said): nobody near
            if !lists.iter().any(|(c, _)| *c == ch) {
                lists.push((ch, Vec::new()));
            }
        }
        for (ch, near) in lists {
            let near = Value::Array(near);
            let who = |l: &Value| l.as_array().map(|a| a.iter().map(|e| (e["key"].clone(), e["id"].clone())).collect::<Vec<_>>()).unwrap_or_default();
            if let Some((was, at)) = self.voice.told.get(&ch) {
                if *was == near || (who(was) == who(&near) && at.elapsed() < NEAR_EVERY) {
                    continue;
                }
            }
            if ch == 0 {
                self.to_page(json!({ "type": "voice_near", "near": near }));
            } else if let Some(v) = self.visits.values().find(|v| v.up && v.channel == ch) {
                let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "near": near })));
            }
            if near.as_array().is_some_and(Vec::is_empty) && (ch != 0 && !self.voice.visitors.contains_key(&ch)) {
                self.voice.told.remove(&ch);   // gone: told once, then forgotten
            } else {
                self.voice.told.insert(ch, (near, Instant::now()));
            }
        }
    }

    // ---------- landscapes (8.10): what never changes, sent once, kept ----------

    /// This room's landscape, from its page: kept, and offered by its hash to every visit to this room.
    fn land_set(&mut self, gz: Bytes) {
        let hash = land::hash(&gz);
        if self.land.as_ref().is_some_and(|(h, _)| *h == hash) {
            return;
        }
        info!(hash = &hash[..12], len = gz.len(), "this room's landscape");
        for v in self.visits.values().filter(|v| v.up && v.role == Role::Host) {
            let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "landscape": hash })));
        }
        self.land = Some((hash, gz));
    }

    /// A host's landscape this office asked for: kept and given to the page if it is the one the host named (by
    /// its hash), else dropped.
    fn land_in(&mut self, id: &str, gz: Bytes) {
        let Some(v) = self.visits.get(id).filter(|v| v.role == Role::Visitor) else { return };
        let (ch, key, want) = (v.channel, v.peer.get("key").and_then(Value::as_str).unwrap_or("").to_string(), v.land_hash.clone());
        let hash = land::hash(&gz);
        if want.as_deref() != Some(hash.as_str()) {
            return warn!(visit = id, "a landscape other than the one its host named: dropped");
        }
        self.lands.put(&key, &hash, &gz);
        self.land_to_page(ch, &key, gz);
    }

    /// An office's landscape for the page, unpacked off the async threads (checked JSON), as text: never dropped,
    /// as a frame may be. On a visit's channel, or 0: a plot kept while its office is away.
    fn land_to_page(&self, ch: u16, key: &str, gz: Bytes) {
        let Some(p) = &self.page else { return };
        let (text, key) = (p.text.clone(), json!(key).to_string());
        tokio::task::spawn_blocking(move || match frames::unpack_scene(&gz).map(String::from_utf8) {
            Ok(Ok(json)) => { let _ = text.send(PageOut::Text(format!("{{\"type\":\"landscape\",\"channel\":{ch},\"key\":{key},\"json\":{json}}}"))); }
            _ => warn!("a landscape kept that is not what it should be"),
        });
    }

    /// That office's plot and landscape, let go (the page told when it had the plot).
    fn forget_plot(&mut self, key: &str) {
        if self.lands.forget(key) {
            self.to_page(json!({ "type": "plot_forgotten", "key": key }));
        }
    }

    // ---------- chat (8.9): a line said, to everyone who can see its speaker ----------

    /// A line this office's user says, to everyone who can see them: to the room they are in (another's: its owner's
    /// visit-client passes it on to everyone there; their own: to each visitor in it, and to each office that has it
    /// in its world or its corner).
    fn say_out(&mut self, text: String) {
        if let Some(v) = self.visits.values().find(|v| v.up && v.role == Role::Visitor && v.inside) {
            let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "say": text })));
            return;
        }
        let line = json!({ "key": self.key, "name": self.office.get("name"), "owner": true, "text": text });
        for v in self.visits.values().filter(|v| v.up && v.role == Role::Host) {
            let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "said": line })));
        }
    }

    /// A line a visitor in this room said: to this office's page, and to everyone else who can see this room (its other
    /// visitors, and those who have it in their worlds or corners).
    fn say_in(&mut self, from: u16, line: Value) {
        for v in self.visits.values().filter(|v| v.up && v.role == Role::Host && v.channel != from) {
            let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "said": line })));
        }
        let mut chat = line;
        chat["type"] = json!("chat");
        chat["channel"] = json!(from);
        self.to_page(chat);
    }

    /// A control message to the office with this key, over any link up with it; false if there is none.
    fn to_peer(&self, key: &str, ctl: Value) -> bool {
        match self.visits.values().find(|v| v.up && v.peer.get("key").and_then(Value::as_str) == Some(key)) {
            Some(v) => v.cmd.try_send(LinkCmd::Ctl(ctl)).is_ok(),
            None => false,
        }
    }

    /// This room has a phone, or no longer: every link told (and each new one, while it has).
    fn set_phone(&mut self, on: bool) {
        if self.phone == on {
            return;
        }
        self.phone = on;
        for v in self.visits.values().filter(|v| v.up) {
            let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "phone": on })));
        }
    }

    fn tell_avatars(&mut self) {
        let avatars = self.saved.avatars_json();
        self.to_page(json!({ "type": "avatars", "default": avatars["default"], "by": avatars["by"] }));
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
                self.watch_order.clear();   // what was waiting for an answer from the last connection gets none
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
                self.lobby_chat = m.get("chat") == Some(&json!(true));
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
                self.to_page(json!({ "type": "online", "office": office, "knocking": knocking, "lobby_chat": self.lobby_chat }));
            }
            "lobby" => {
                self.lobby_view = Some(m.clone());
                self.to_page(m);
                self.watch_guests();
            }
            // This office's own knocks to watch, and what became of them: never the page's.
            "knock_sent" if m.get("watch").and_then(Value::as_bool) == Some(true) => {
                self.watch_order.pop_front();
                if let (Some(kid), Some(to)) = (m.get("id").and_then(Value::as_str), m.get("to").and_then(Value::as_str)) {
                    self.watch_knocks.insert(kid.to_string(), to.to_string());
                }
            }
            "answered" if m.get("watch").and_then(Value::as_bool) == Some(true) => {
                let to = m.get("knock").and_then(Value::as_str).and_then(|k| self.watch_knocks.remove(k));
                if let Some(to) = to {
                    self.watch_pending.remove(&to);
                    if m.get("accept").and_then(Value::as_bool) != Some(true) {
                        if let Some(key) = self.office_key(&to) {
                            self.forget_plot(&key);   // their door shut to this office, or no longer a guest: not kept
                            self.watch_declined.insert(key, Instant::now());
                        }
                    }
                }
            }
            "error" if m.get("ref").and_then(Value::as_str) == Some("watch") => {
                // The oldest knock to watch the lobby has not answered: refused (not ready, full...). Not again for a while.
                if let Some(to) = self.watch_order.pop_front() {
                    debug!(code = ?m.get("code"), to, "a knock to watch refused by the lobby");
                    self.watch_pending.remove(&to);
                    if let Some(key) = self.office_key(&to) {
                        self.watch_declined.insert(key, Instant::now());
                    }
                }
            }
            "knock" if m.get("watch").and_then(Value::as_bool) == Some(true) => {
                // To watch: a guest through the open door is let in; anyone else declined. The page is never asked.
                if !self.let_guest_in(&m) {
                    if let Some(kid) = m.get("id").and_then(Value::as_str) {
                        let kid = kid.to_string();
                        self.to_lobby(json!({ "type": "answer", "knock": kid, "accept": false }));
                    }
                }
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
            // A line said to everyone in the lobby (8.9), checked as any line is, to the page.
            // A line said to everyone in the lobby, or whispered to this office's user (8.9): checked as any line is, to the page.
            "lobby_chat" | "whisper" => {
                let from = m.get("from").cloned().unwrap_or(Value::Null);
                let s = |x: &Value, n: usize| x.as_str().map(|s| s.chars().filter(|c| !c.is_control()).take(n).collect::<String>());
                if let (Some(text), Some(id)) = (m.get("text").and_then(Value::as_str).and_then(said), s(&from["id"], 40)) {
                    let key = s(&from["key"], 100).filter(|k| state::key_ok(k));
                    let scope = if t == "whisper" { "whisper" } else { "lobby" };
                    self.to_page(json!({ "type": "chat", "scope": scope, "id": id, "key": key, "name": s(&from["name"], 24).unwrap_or_default(), "text": text }));
                }
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
        let watch = m.get("watch").and_then(Value::as_bool) == Some(true);
        let link = watch && m.get("link").and_then(Value::as_bool) == Some(true);
        if watch && role == Role::Visitor {
            self.watch_pending.remove(peer.get("id").and_then(Value::as_str).unwrap_or(""));
        }
        if !watch && role == Role::Visitor {
            // A visit to another room: out of any plot this office had stepped into (in one room at a time).
            let inside: Vec<(String, u16)> = self.visits.values().filter(|v| v.role == Role::Visitor && v.watch && v.inside).map(|v| (v.id.clone(), v.channel)).collect();
            for (other, ch) in inside {
                self.step_out(&other);
                self.to_page(json!({ "type": "enter_refused", "channel": ch, "reason": "moved" }));
            }
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
                    points: (Instant::now(), 0), guest, watch, inside: !watch, shared_adds: false, link, in_world: false, avatar_asked: false, possessions_asked: Vec::new(), peer_possessions: json!([]), peer_phone: false,
                    call_on: false, speaker: false, says: (Instant::now(), 0),
                    landscapes: false, land_sent: None, land_hash: None,
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
        // Ended by its host on purpose (its door shut to this office, no longer a guest, kicked): its plot is not kept.
        if v.role == Role::Visitor && reason == "kicked" {
            if let Some(key) = v.peer.get("key").and_then(Value::as_str) {
                self.forget_plot(key);
            }
        }
        if v.role == Role::Host && v.inside {
            self.voice.visitors.remove(&v.channel);
            self.tell_near();
        }
        if v.up {
            self.to_page(json!({ "type": "visit_ended", "id": id, "channel": v.channel, "reason": reason }));
        }
        // Their last link gone: where they had put this office is no longer told, nor known.
        if let Some(key) = v.peer.get("key").and_then(Value::as_str) {
            if !self.visits.values().any(|o| o.peer.get("key").and_then(Value::as_str) == Some(key)) && self.seen_in.remove(key).is_some() {
                self.to_page(json!({ "type": "seen", "key": key, "name": v.peer.get("name"), "at": null }));
            }
        }
    }

    fn end_all(&mut self, reason: &str) {
        for id in self.visits.keys().cloned().collect::<Vec<_>>() {
            self.end_visit(&id, reason);
        }
    }

    /// The visit whose room this office is in: where its input and points go.
    fn visiting(&self) -> Option<&Visit> {
        self.visits.values().find(|v| v.role == Role::Visitor && v.up && v.inside)
    }

    fn office_key(&self, id: &str) -> Option<String> {
        self.lobby_view.as_ref()?.get("offices")?.as_array()?.iter()
            .find(|o| o.get("id").and_then(Value::as_str) == Some(id))?
            .get("key").and_then(Value::as_str).map(str::to_string)
    }

    /// The world on (the page draws its guests' plots) or off (its watches end).
    fn set_world(&mut self, on: bool) {
        self.world = on;
        self.world_ask = None;
        if on {
            self.watch_declined.clear();   // asked anew: try everyone again
            self.watch_guests();
        } else {
            let watches: Vec<String> = self.visits.values().filter(|v| v.role == Role::Visitor && v.watch && !v.link).map(|v| v.id.clone()).collect();
            for id in watches {
                self.to_lobby(json!({ "type": "end", "visit": id }));
            }
        }
    }

    /// With the world on: a knock to watch each guest online and ready that this office does not watch yet,
    /// unless one is waiting or was declined a while ago; at most MAX_WATCHING at once.
    fn watch_guests(&mut self) {
        if !self.world || !self.online || self.hosting.is_none() || self.link.is_none() {
            return;
        }
        let now = Instant::now();
        self.watch_pending.retain(|_, at| now.duration_since(*at) < WATCH_PENDING);
        self.watch_declined.retain(|_, at| now.duration_since(*at) < WATCH_DECLINED);
        let me = self.office.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let watched: Vec<String> = self.visits.values().filter(|v| v.role == Role::Visitor && v.watch)
            .filter_map(|v| v.peer.get("id").and_then(Value::as_str).map(str::to_string)).collect();
        let mut room = MAX_WATCHING.saturating_sub(watched.len() + self.watch_pending.len());
        let offices: Vec<Value> = self.lobby_view.as_ref().and_then(|l| l.get("offices")).and_then(Value::as_array).cloned().unwrap_or_default();
        for o in offices {
            if room == 0 {
                break;
            }
            let (Some(id), Some(key)) = (o.get("id").and_then(Value::as_str), o.get("key").and_then(Value::as_str)) else { continue };
            // Only an office whose visit-client takes knocks to watch (an older one would show them to its page).
            if id == me || o.get("ready").and_then(Value::as_bool) != Some(true) || o.get("world").and_then(Value::as_bool) != Some(true)
                || watched.iter().any(|w| w == id)
                || self.watch_pending.contains_key(id) || self.watch_declined.contains_key(key) || !self.saved.guests.iter().any(|g| g.key == key)
            {
                continue;
            }
            debug!(to = id, "a knock to watch a guest's plot");
            self.watch_pending.insert(id.to_string(), now);
            self.watch_order.push_back(id.to_string());
            let _ = self.lobby.send(LobbyOut::Msg(json!({ "type": "knock", "to": id, "watch": true })));
            room -= 1;
        }
    }

    /// The watches of this office's plot whose watcher's key passes `which`: ended (`kicked`). Not links: their
    /// host let them in itself.
    fn end_watchers(&mut self, which: impl Fn(&str) -> bool) {
        let ends: Vec<String> = self.visits.values()
            .filter(|v| v.role == Role::Host && v.watch && !v.link && which(v.peer.get("key").and_then(Value::as_str).unwrap_or("")))
            .map(|v| v.id.clone()).collect();
        for id in ends {
            self.to_lobby(json!({ "type": "end", "visit": id, "reason": "kicked" }));
        }
    }

    /// Out of a watched plot's room (visitor side): its host no longer has this office; the watch goes on.
    fn step_out(&mut self, id: &str) {
        if let Some(v) = self.visits.get_mut(id).filter(|v| v.inside) {
            v.inside = false;
            let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "exit": true })));
        }
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
        let (has_page, phone) = (self.page.is_some(), self.phone);
        let Some(v) = self.visits.get_mut(id) else { return };
        v.up = true;
        let (role, cmd) = (v.role, v.cmd.clone());
        if phone {   // this room has a phone: the other side hears of it, as every link does
            let _ = cmd.try_send(LinkCmd::Ctl(json!({ "phone": true })));
        }
        if let Some((hash, _)) = self.land.as_ref().filter(|_| role == Role::Host) {   // this room's landscape, by its hash
            let _ = cmd.try_send(LinkCmd::Ctl(json!({ "landscape": hash })));
        }
        if let Some(at) = v.peer.get("key").and_then(Value::as_str).and_then(|k| self.seen_out.get(k)) {   // where they are in this world
            let _ = cmd.try_send(LinkCmd::Ctl(json!({ "seen": at })));
        }
        let started = started(v);
        match role {
            Role::Visitor => {
                let _ = cmd.try_send(LinkCmd::Ctl(json!({ "shared_adds": true })));
                if !self.possessions.is_empty() {   // what this office's user owns (8.11)
                    let _ = cmd.try_send(LinkCmd::Ctl(json!({ "possessions": self.possessions.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>() })));
                }
                let _ = cmd.try_send(LinkCmd::Ctl(json!({ "landscapes": true })));
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
        if let Some(on) = m.get("phone").and_then(Value::as_bool) {   // the other room has a phone now, or no longer
            v.peer_phone = on;
            return self.to_page(json!({ "type": "phone", "channel": ch, "on": on }));
        }
        if let Some(act) = m.get("call").and_then(Value::as_str).filter(|a| ["ring", "answer", "hangup"].contains(a)) {
            let act = act.to_string();
            call_state(v, &act);
            self.to_page(json!({ "type": "call", "channel": ch, "act": act }));
            return self.tell_near();
        }
        if let Some(text) = m.get("sim_say").and_then(Value::as_str).and_then(said) {   // a line said into this room from a linked office (8.9)
            if !counted(&mut v.says) {
                return;
            }
            let (key, name) = (v.peer.get("key").cloned().unwrap_or(Value::Null), v.peer.get("name").cloned().unwrap_or(Value::Null));
            let line = json!({ "key": key, "name": name, "text": text });
            // To everyone in this room, but its sayer (in it, or with a link the other way too)
            for o in self.visits.values().filter(|o| o.up && o.role == Role::Host && o.inside && o.channel != ch && o.peer.get("key") != Some(&key)) {
                let _ = o.cmd.try_send(LinkCmd::Ctl(json!({ "sim_said": line })));
            }
            return self.to_page(json!({ "type": "chat", "scope": "sim", "home": true, "key": key, "name": name, "text": text, "channel": ch }));
        }
        if let Some(at) = m.get("seen") {   // where the other office has put this one in its world (or nowhere): to the page
            let Some(key) = v.peer.get("key").and_then(Value::as_str).map(str::to_string) else { return };
            let name = v.peer.get("name").cloned().unwrap_or(Value::Null);
            let at = seen_from(at).unwrap_or(Value::Null);
            if at.is_null() {
                self.seen_in.remove(&key);
            } else {
                self.seen_in.insert(key.clone(), (name.clone(), at.clone()));
            }
            return self.to_page(json!({ "type": "seen", "key": key, "name": name, "at": at }));
        }
        let Some(v) = self.visits.get_mut(id) else { return };
        match v.role {
            // From a watcher: stepping into this room (where, in its terms), or out of it. In, it counts toward
            // max_visitors: one past it is refused, and stays outside.
            Role::Host if v.watch && m.get("enter").is_some() => {
                if v.inside {
                    return;
                }
                let pose = m["enter"].is_object().then(|| clamp_pose(&m["enter"]));
                let full = self.visits.values().filter(|x| x.role == Role::Host && x.inside).count() >= self.max_visitors as usize;
                let v = self.visits.get_mut(id).expect("just found");
                if full {
                    let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "enter_refused": "full" })));
                } else {
                    v.inside = true;
                    let mut enter = json!({ "type": "enter", "channel": ch });
                    if let Some(pose) = pose {   // none: a link stepping in, where the room puts newcomers
                        enter["pose"] = pose;
                    }
                    self.to_page(enter);
                }
            }
            Role::Host if v.watch && m.get("exit").is_some() => {
                if v.inside {
                    v.inside = false;
                    self.to_page(json!({ "type": "exit", "channel": ch }));
                    self.voice.visitors.remove(&ch);
                    self.tell_near();
                }
            }
            // From the visitor.
            Role::Host => {
                if let Some(list) = m.get("possessions") {   // what the visitor owns (8.11): checked, kept, to the page
                    if let Some(list) = possessions_from(Some(list)) {
                        v.peer_possessions = json!(list);
                        self.to_page(json!({ "type": "possessions", "channel": ch, "list": list }));
                    }
                } else if m.get("landscapes") == Some(&json!(true)) {   // the visitor reads landscapes (8.10): its page told, once
                    if !v.landscapes {
                        v.landscapes = true;
                        self.to_page(json!({ "type": "landscapes", "channel": ch }));
                    }
                } else if let Some(want) = m.get("landscape_want").and_then(Value::as_str) {   // this room's landscape, once a link
                    if let Some((hash, gz)) = self.land.as_ref().filter(|(h, _)| h == want) {
                        if v.land_sent.as_deref() != Some(hash.as_str()) {
                            info!(visit = %v.id, hash = &hash[..12], "this room's landscape sent");
                            v.land_sent = Some(hash.clone());
                            let _ = v.cmd.try_send(LinkCmd::Land(gz.clone()));
                        }
                    }
                } else if m.get("shared_adds") == Some(&json!(true)) {
                    if !v.shared_adds {
                        v.shared_adds = true;
                        self.to_page(json!({ "type": "shared_adds", "channel": ch }));
                    }
                } else if let Some(text) = m.get("say").filter(|_| v.inside).and_then(Value::as_str).and_then(said) {
                    if counted(&mut v.says) {
                        let line = json!({ "key": v.peer.get("key"), "name": v.peer.get("name"), "id": v.id, "text": text });
                        self.say_in(ch, line);
                    }
                } else if m.get("scene_resync").is_some() {
                    v.resync_due = true;
                    self.resyncs();
                } else if m.get("keyframe").is_some() && v.key_asked.is_none_or(|t| t.elapsed() >= KEY_EVERY) {
                    v.key_asked = Some(Instant::now());
                    self.to_page(json!({ "type": "keyframe", "channel": ch }));
                } else if let Some(p) = m.get("point").filter(|_| v.inside) {
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
                if let Some(id) = m.get("possession_want").and_then(Value::as_str).filter(|id| link::possession_id_ok(id)) {   // the host would draw it (8.11)
                    if !v.possessions_asked.iter().any(|a| a == id) && v.possessions_asked.len() < MAX_POSSESSIONS {
                        v.possessions_asked.push(id.to_string());
                    }
                    if let Some((_, Some(gz))) = self.possessions.iter().find(|(p, _)| p["id"] == id) {
                        let _ = v.cmd.try_send(LinkCmd::Possession(id.to_string(), gz.clone()));
                    }
                } else if m.get("avatar_want").is_some() {   // the host's page would draw this office as itself (8.6)
                    v.avatar_asked = true;
                    if let Some(gz) = self.avatar.clone() {
                        let _ = v.cmd.try_send(LinkCmd::Avatar(gz));
                    }
                } else if let Some(h) = m.get("landscape").and_then(Value::as_str).filter(|h| land::hash_ok(h)) {   // the host's landscape (8.10)
                    let (h, key, cmd) = (h.to_string(), v.peer.get("key").and_then(Value::as_str).unwrap_or("").to_string(), v.cmd.clone());
                    v.land_hash = Some(h.clone());
                    match self.lands.get(&key, &h) {
                        Some(gz) => self.land_to_page(ch, &key, gz),   // kept: nothing to send
                        None => { let _ = cmd.try_send(LinkCmd::Ctl(json!({ "landscape_want": h }))); }
                    }
                } else if let Some(p) = m.get("paused").and_then(Value::as_bool) {
                    self.to_page(json!({ "type": if p { "host_paused" } else { "host_resumed" }, "channel": ch }));
                } else if let Some(line) = m.get("said").and_then(said_from) {   // a line said in the host's room (8.9)
                    let mut line = line;
                    line["type"] = json!("chat");
                    line["channel"] = json!(ch);
                    self.to_page(line);
                } else if let Some(line) = m.get("sim_said").filter(|_| v.inside).and_then(said_from) {   // said into it, from a linked office
                    self.to_page(json!({ "type": "chat", "scope": "sim", "key": line["key"], "name": line["name"], "text": line["text"], "channel": ch }));
                } else if let Some(near) = m.get("near").filter(|_| v.inside) {   // who is near this office's user in the host's room (8.7)
                    self.to_page(json!({ "type": "voice_near", "channel": ch, "near": near_from(near) }));
                } else if let Some(reason) = m.get("enter_refused").filter(|_| v.watch && v.inside) {
                    v.inside = false;
                    let reason = reason.as_str().unwrap_or("refused").chars().take(40).collect::<String>();
                    self.to_page(json!({ "type": "enter_refused", "channel": ch, "reason": reason }));
                }
            }
        }
    }

    /// A visitor's input, checked and clamped, at most 60 a second, newest only.
    fn link_input(&mut self, id: &str, m: Value) {
        let Some(v) = self.visits.get_mut(id).filter(|v| v.role == Role::Host && v.inside) else { return };
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
    if v.shared_adds {
        m["shared_adds"] = json!(true);
    }
    if v.landscapes {
        m["landscapes"] = json!(true);
    }
    if v.peer_phone {
        m["phone"] = json!(true);
    }
    if v.peer_possessions.as_array().is_some_and(|l| !l.is_empty()) {
        m["possessions"] = v.peer_possessions.clone();
    }
    if v.link {
        m["link"] = json!(true);
        if v.in_world {
            m["where"] = json!("world");
        }
    }
    if v.watch {
        m["watch"] = json!(true);
        m["inside"] = json!(v.inside);
    }
    m
}

/// Where a watcher steps into a room, in that room's own terms: x, y, z and yaw, each a number in range.
fn clamp_pose(m: &Value) -> Value {
    let num = |k: &str| m.get(k).and_then(Value::as_f64).filter(|x| x.is_finite()).map_or(0.0, |x| x.clamp(-1e6, 1e6));
    let air = m.get("air").and_then(Value::as_f64).filter(|x| x.is_finite()).map_or(0.0, |x| x.clamp(0.0, 1e6));
    json!({ "x": num("x"), "y": num("y"), "z": num("z"), "yaw": num("yaw"), "air": air })
}

/// A point (8.3): where the visitor looked as it clicked, `yaw` and `pitch` in the same terms as its input, each
/// in its range; nothing else of what was sent passes.
fn clamp_point(m: &Value) -> Value {
    let angle = |k: &str, lim: f64| m.get(k).and_then(Value::as_f64).filter(|x| x.is_finite()).map_or(0.0, |x| x.clamp(-lim, lim));
    json!({ "yaw": angle("yaw", 1e6), "pitch": angle("pitch", 1.4) })
}

/// A call's state on a link, by what passed either way: on when answered, over when hung up.
fn call_state(v: &mut Visit, act: &str) {
    match act {
        "answer" => v.call_on = true,
        "hangup" => (v.call_on, v.speaker) = (false, false),
        _ => {}
    }
}

/// A line of chat as it may be said (8.9): no control characters, trimmed, at most SAY_LEN characters; none if empty.
fn said(text: &str) -> Option<String> {
    let t: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().trim().chars().take(SAY_LEN).collect();
    let t = t.trim_end().to_string();
    (!t.is_empty()).then_some(t)
}

/// A line the host says was said in its room, checked: who (a key, a name; a visitor's visit id there, or the
/// room's owner) and what.
fn said_from(v: &Value) -> Option<Value> {
    let s = |x: &Value, n: usize| x.as_str().map(|s| s.chars().filter(|c| !c.is_control()).take(n).collect::<String>());
    let mut out = json!({ "key": s(&v["key"], 100)?, "name": s(&v["name"], 24).unwrap_or_default(), "text": said(v["text"].as_str()?)? });
    if let Some(id) = s(&v["id"], 40) {
        out["id"] = json!(id);
    } else if v["owner"] == json!(true) {
        out["owner"] = json!(true);
    }
    Some(out)
}

/// One more in a window of SAYS a SAY_WINDOW: true if it may go.
fn counted(w: &mut (Instant, u32)) -> bool {
    if w.0.elapsed() >= SAY_WINDOW {
        *w = (Instant::now(), 0);
    }
    w.1 += 1;
    w.1 <= SAYS
}

/// A spot in a room, in metres: [x, y, z], each finite and within 100 km; null or anything else, none.
fn spot(v: Option<&Value>) -> Option<[f64; 3]> {
    let a = v?.as_array().filter(|a| a.len() == 3)?;
    let n = |i: usize| a[i].as_f64().filter(|x| x.is_finite() && x.abs() <= 1e5);
    Some([n(0)?, n(1)?, n(2)?])
}

/// How far apart two spots are across the floor (height aside), in metres.
fn flat(a: [f64; 3], b: [f64; 3]) -> f64 {
    (a[0] - b[0]).hypot(a[2] - b[2])
}

/// Who a host says is near this office's user (8.7), checked: at most 64, each with a key, a name, a distance and
/// (a visitor) the id of its visit there, or (a call on the room's speaker) `phone`.
fn near_from(v: &Value) -> Value {
    let s = |x: &Value, n: usize| x.as_str().map(|s| s.chars().take(n).collect::<String>());
    Value::Array(v.as_array().into_iter().flatten().take(64).filter_map(|e| {
        let mut out = json!({ "key": s(&e["key"], 100)?, "name": s(&e["name"], 24).unwrap_or_default(),
            "distance": e["distance"].as_f64().filter(|d| d.is_finite() && *d >= 0.0 && *d <= 1e5)? });
        if let Some(id) = s(&e["id"], 40) {
            out["id"] = json!(id);
        }
        if e["phone"] == json!(true) {
            out["phone"] = json!(true);
        }
        Some(out)
    }).collect())
}

/// Where an office has put another's plot in its world, beside its own (8.4), as sent and passed on: `dx`, `dz`
/// metres from its own plot's middle (within 100 km), `turn` quarter turns left (0-3), and its own plot's `size`.
fn seen_from(v: &Value) -> Option<Value> {
    let n = |k: &str| v.get(k).and_then(Value::as_f64).filter(|x| x.is_finite() && x.abs() <= 1e5);
    let turn = v.get("turn").and_then(Value::as_u64).filter(|t| *t < 4)?;
    Some(json!({ "dx": n("dx")?, "dz": n("dz")?, "turn": turn, "size": state::size_from(v.get("size"))? }))
}

/// A three.js revision, as `THREE.REVISION` says it: digits.
fn revision(r: &str) -> bool {
    (1..=4).contains(&r.len()) && r.bytes().all(|b| b.is_ascii_digit())
}

/// An input with every field in its range (../SPEC.md section 8.2). `t` (the visitor page's clock when it
/// sent it, ms) passes through as a number, for the host to echo in its deltas.
/// The most possessions an office says it has (8.11), besides Visit's own.
const MAX_POSSESSIONS: usize = 8;

/// A list of possessions (8.11) as a page or a visitor says it, checked: at most MAX_POSSESSIONS, each { id (unique),
/// name, mount, fly, speed (0.25 to 5 times walking pace), lift (0 to 5 m) }. None if it is not one.
fn possessions_from(l: Option<&Value>) -> Option<Vec<Value>> {
    let l = l?.as_array().filter(|l| l.len() <= MAX_POSSESSIONS)?;
    let mut out: Vec<Value> = Vec::new();
    for p in l {
        let id = p.get("id").and_then(Value::as_str).filter(|id| link::possession_id_ok(id))?;
        if out.iter().any(|o| o["id"] == id) {
            return None;
        }
        let num = |k: &str, d: f64, lo: f64, hi: f64| p.get(k).and_then(Value::as_f64).filter(|x| x.is_finite()).map_or(d, |x| x.clamp(lo, hi));
        out.push(json!({
            "id": id, "name": state::clip_name(p.get("name").and_then(Value::as_str).unwrap_or(id)),
            "mount": p.get("mount") == Some(&json!(true)), "fly": p.get("fly") == Some(&json!(true)),
            "speed": num("speed", 1.0, 0.25, 5.0), "lift": num("lift", 0.0, 0.0, 5.0),
        }));
    }
    Some(out)
}

fn clamp_input(m: &Value) -> Value {
    let step = |k: &str| m.get(k).and_then(Value::as_f64).filter(|x| x.is_finite()).map_or(0, |x| x.round().clamp(-1.0, 1.0) as i64);
    let angle = |k: &str, lim: f64| m.get(k).and_then(Value::as_f64).filter(|x| x.is_finite()).map_or(0.0, |x| x.clamp(-lim, lim));
    // What the visitor rides (8.11): one of its possessions, or Visit's own (`visit:` and a name); the host decides.
    let riding = m.get("riding").and_then(Value::as_str)
        .filter(|r| link::possession_id_ok(r) || r.strip_prefix("visit:").is_some_and(link::possession_id_ok));
    json!({
        "forward": step("forward"), "strafe": step("strafe"), "up": step("up"), "run": m.get("run").and_then(Value::as_bool).unwrap_or(false),
        "riding": riding,
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
    fn a_line_said_is_plain_and_short() {
        assert_eq!(said("  hi\tthere\n "), Some("hi there".to_string()));
        assert_eq!(said(&"é".repeat(300)).map(|t| t.chars().count()), Some(SAY_LEN));
        assert!(said(" \n\t ").is_none() && said("").is_none());
        let line = said_from(&json!({ "key": "k1", "name": "Ada\u{7}", "id": "v1", "owner": true, "text": "hello\u{1b}[31m", "evil": 1 })).unwrap();
        assert_eq!(line, json!({ "key": "k1", "name": "Ada", "id": "v1", "text": "hello [31m" }));
        assert_eq!(said_from(&json!({ "key": "k2", "owner": true, "text": "yo" })), Some(json!({ "key": "k2", "name": "", "owner": true, "text": "yo" })));
        assert!(said_from(&json!({ "key": "k3", "text": "  " })).is_none() && said_from(&json!({ "text": "no key" })).is_none());
        let mut w = (Instant::now(), 0);
        assert_eq!((0..7).map(|_| counted(&mut w)).filter(|ok| *ok).count(), SAYS as usize);
    }

    #[test]
    fn where_voices_are_and_who_is_near() {
        assert_eq!(spot(Some(&json!([1, 1.6, -2.5]))), Some([1.0, 1.6, -2.5]));
        assert!(spot(Some(&json!([1, 2]))).is_none() && spot(Some(&json!([1e6, 0, 0]))).is_none() && spot(Some(&Value::Null)).is_none() && spot(None).is_none());
        assert_eq!(flat([0.0, 0.0, 0.0], [3.0, 9.0, 4.0]), 5.0);   // across the floor: height aside
        let near = near_from(&json!([{ "key": "k1", "name": "Ada", "distance": 12, "id": "v1", "evil": 1 },
            { "key": "phone", "name": "Bo", "distance": 2, "phone": true }, { "name": "no key", "distance": 1 }, { "key": "k3", "distance": -1 }]));
        assert_eq!(near, json!([{ "key": "k1", "name": "Ada", "distance": 12.0, "id": "v1" }, { "key": "phone", "name": "Bo", "distance": 2.0, "phone": true }]));
        assert_eq!(near_from(&json!("nobody")), json!([]));
    }

    #[test]
    fn where_one_is_seen_is_bare() {
        let s = seen_from(&json!({ "dx": 22.5, "dz": -4, "turn": 1, "size": [12, 9], "others": [{ "key": "x" }] }));
        assert_eq!(s, Some(json!({ "dx": 22.5, "dz": -4.0, "turn": 1, "size": [12.0, 9.0] })));
        assert!(seen_from(&json!({ "dx": 1, "dz": 1, "turn": 4, "size": [1, 1] })).is_none());
        assert!(seen_from(&json!({ "dx": 1e6, "dz": 1, "turn": 0, "size": [1, 1] })).is_none());
        assert!(seen_from(&json!({ "dx": 1, "dz": 1, "turn": 0 })).is_none());
    }

    #[test]
    fn inputs_are_clamped() {
        let i = clamp_input(&json!({ "forward": 5, "strafe": -0.6, "up": 0.7, "run": "yes", "yaw": 3.0, "pitch": -9 }));
        assert_eq!(i, json!({ "forward": 1, "strafe": -1, "up": 1, "run": false, "riding": null, "yaw": 3.0, "pitch": -1.4, "t": 0.0 }));
        let j = clamp_input(&json!({ "t": 1234.5 }));
        assert_eq!(j, json!({ "forward": 0, "strafe": 0, "up": 0, "run": false, "riding": null, "yaw": 0.0, "pitch": 0.0, "t": 1234.5 }));
        assert_eq!(clamp_input(&json!({ "riding": "visit:horse" }))["riding"], json!("visit:horse"));
        assert_eq!(clamp_input(&json!({ "riding": "my-dragon.2" }))["riding"], json!("my-dragon.2"));
        for bad in [json!("a b"), json!("other:horse"), json!(5), json!("x".repeat(41))] {
            assert_eq!(clamp_input(&json!({ "riding": bad }))["riding"], Value::Null);
        }
    }

    #[test]
    fn possessions_are_checked() {
        let l = possessions_from(Some(&json!([{ "id": "dragon", "name": "Smaug\u{7}", "mount": true, "fly": true, "speed": 9, "lift": -1, "extra": 1 }, { "id": "cat" }]))).unwrap();
        assert_eq!(l, vec![json!({ "id": "dragon", "name": "Smaug", "mount": true, "fly": true, "speed": 5.0, "lift": 0.0 }),
            json!({ "id": "cat", "name": "cat", "mount": false, "fly": false, "speed": 1.0, "lift": 0.0 })]);
        assert!(possessions_from(Some(&json!([{ "id": "a" }, { "id": "a" }]))).is_none());   // twice the same
        assert!(possessions_from(Some(&json!([{ "id": "visit:horse" }]))).is_none());   // Visit's own are not a page's
        assert!(possessions_from(Some(&json!((0..9).map(|i| json!({ "id": format!("p{i}") })).collect::<Vec<_>>()))).is_none());
        assert!(possessions_from(Some(&json!("dragon"))).is_none() && possessions_from(None).is_none());
        assert_eq!(possessions_from(Some(&json!([]))), Some(vec![]));
    }

    #[test]
    fn an_entering_pose_says_how_high_in_the_air() {
        let p = clamp_pose(&json!({ "x": 1, "y": 2, "z": 3, "yaw": 0.5, "air": 7.5, "fly": true }));
        assert_eq!(p, json!({ "x": 1.0, "y": 2.0, "z": 3.0, "yaw": 0.5, "air": 7.5 }));
        assert_eq!(clamp_pose(&json!({ "air": -4 }))["air"], json!(0.0));
        assert_eq!(clamp_pose(&json!({ "x": 1 }))["air"], json!(0.0));
    }

    #[test]
    fn points_are_clamped_and_bare() {
        let p = clamp_point(&json!({ "type": "point", "yaw": 2.5, "pitch": 9, "target": "the front door", "channel": 3 }));
        assert_eq!(p, json!({ "yaw": 2.5, "pitch": 1.4 }));
        assert_eq!(clamp_point(&json!({ "yaw": "left", "pitch": null })), json!({ "yaw": 0.0, "pitch": 0.0 }));
    }
}
