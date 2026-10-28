//! The visit-client's core: one task owns all its state (the office, the lobby as last seen, the knocks
//! on its door, the visits) and routes what comes in from the page, the lobby and the links (../SPEC.md
//! sections 4-8). Everything else talks to it through `Ev`s.
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    path::PathBuf,
    time::{Duration, Instant},
};

use bytes::Bytes;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tracing::{debug, info, trace, warn};

use crate::{
    db::{self, DbCmd, MediaTo, CHAT_KEPT},
    frames::{self, Frame},
    land::{self, Kept, Lands},
    link::{self, LinkCmd, Links, Relays, Role},
    lobby::LobbyOut,
    media,
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
    /// A voice in a room voice (8.7): a member's to this office's room (`up`), or the room's to this member.
    LinkVoice { visit: String, up: bool, data: Bytes },
    /// A picture the other side sent, as asked (8.12): checked (its bytes are its id's), its type.
    LinkMedia { visit: String, id: String, mime: String, bytes: Bytes },
    /// The database's answers (8.12): a picture asked for (none: not here); whether it has one a line named; and
    /// what the page asked for (its history, what was shared), to the page as it is.
    DbMedia { id: String, to: MediaTo, found: Option<(String, Bytes)> },
    DbHas { id: String, visit: String, has: bool },
    DbReply(Value),
    /// A link's preview, made for the page (none: nothing to show).
    Preview { req: Value, url: String, found: Option<media::Preview> },
    Tick,
    Shutdown,
}

/// What the page is told (frames go apart, on a queue that drops them when the page falls behind).
pub enum PageOut {
    Text(String),
    /// A binary message never dropped (a picture the page asked for), unlike a frame.
    Binary(Bytes),
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
    /// Who the host says is near this office's user in its room (visitor side, 8.7), by key: they are heard in
    /// person, and a call or a room voice with them goes quiet.
    near_keys: Vec<String>,
    /// The name the other office's user goes by (8.9: `user`, as their page said), if they gave one.
    peer_user: Option<String>,
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
    /// Across a plot's side (8.7): where this office's world has each friend whose room is a plot in it, by key (its
    /// owner, at home there); those it has told it has them within reach (both at home), and those who say the same
    /// of it. Both: they hear each other.
    world: HashMap<String, [f64; 3]>,
    world_told: HashSet<String>,
    world_heard: HashSet<String>,
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
/// Pictures (8.12) kept in memory too, the last few, while the database takes them.
const MEDIA_RECENT: usize = 8;
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
    /// Lines each of this room's own figures said (`say_as`, 8.9), by its id, in its current window.
    npc_says: HashMap<String, (Instant, u32)>,
    /// The chat this office's user has had (8.9), theirs too: the last CHAT_KEPT lines, each with when, for a page
    /// that comes back (a reload); all of it is in the database (8.12), and this run began with its last lines.
    chat: VecDeque<Value>,
    /// The database (8.12): what this office keeps, asked of its task.
    db: mpsc::UnboundedSender<DbCmd>,
    /// Pictures a line named that this office does not have (or had not, when asked): when, from which visit, and
    /// whether that visit was asked for it yet; and who waits for each (the page, a link).
    media_asked: HashMap<String, (Instant, String, bool)>,
    media_waiting: HashMap<String, Vec<MediaTo>>,
    /// The last pictures kept (MEDIA_RECENT): one asked for while still on its way into the database is had here.
    media_recent: VecDeque<(String, String, Bytes)>,
    /// The name this office's user goes by (8.9), as its page said (`user`): shown to others with what they say.
    user_name: Option<String>,
    /// The room voice this office's user is in (8.7), by its room's owner's key (this office's own: its own room's);
    /// and who else is in this office's own room's voice, by key (their names).
    room_voice: Option<String>,
    voice_members: BTreeMap<String, Value>,
    /// Rooms that keep this office's user out of their voice or chat (8.9), by key: (their name, voice, chat).
    banned_by: HashMap<String, (Value, bool, bool)>,
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
               saved: Saved, fresh: bool, state_file: Option<PathBuf>, lands: Lands, db: mpsc::UnboundedSender<DbCmd>, chat: Vec<Value>) -> Core {
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
            npc_says: HashMap::new(),
            chat: chat.into_iter().collect(),
            db,
            media_asked: HashMap::new(),
            media_waiting: HashMap::new(),
            media_recent: VecDeque::new(),
            user_name: None,
            room_voice: None,
            voice_members: BTreeMap::new(),
            banned_by: HashMap::new(),
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
                    self.media_expire();
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
            Ev::LinkVoice { visit, up, data } => self.room_voice_in(&visit, up, data),
            Ev::LinkMedia { visit, id, mime, bytes } => self.media_in(&visit, id, mime, bytes),
            Ev::DbMedia { id, to, found } => self.db_media(id, to, found),
            Ev::DbHas { id, visit, has } => self.db_has(id, &visit, has),
            Ev::DbReply(m) => self.to_page(m),
            Ev::Preview { req, url, found } => self.preview_in(req, url, found),
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
            "users": self.users_json(),
            "bans": self.saved.bans_json(), "banned_by": self.banned_by_json(), "room_voice": self.room_voice_json(), "voice_members": self.voice_members_json(),
        }));
        if let Some(view) = self.lobby_view.clone() {
            self.to_page(view);
        }
        if !self.chat.is_empty() {   // the chat this office's user had (8.9), lines that came while no page was here too
            self.to_page(json!({ "type": "chat_log", "lines": self.chat }));
        }
        if let Some(k) = self.room_voice.clone().filter(|k| *k != self.key) {   // a room voice its user is in: who is in it, again
            self.to_peer(&k, json!({ "voice_join": true }));
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
            // Possessions (8.11): what this office's user owns and brings along, as its room makes them (Visit has none
            // of its own). Every host it visits is told what they are; a host's page asks for one's model
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
            // those who have it in their worlds or corners); "room", this office's room's chat (everyone in it, and every
            // office linked with it); { key }, a linked office's room's chat; { whisper }, to the user of the office with
            // that id alone, through the lobby; "lobby", everyone in the lobby.
            "say" => {
                let (media, links) = media::attachments(&m);
                let text = m.get("text").and_then(Value::as_str).map(said_text).unwrap_or_default();
                if text.is_empty() && media.is_empty() && links.is_empty() {
                    return self.page_error("bad_message", &format!("text is 1 to {SAY_LEN} characters, or the line has pictures or links"), Some("say"));
                }
                let shares = !media.is_empty() || !links.is_empty();
                let to = m.get("to").filter(|t| !t.is_null() && t.as_str() != Some("here"));
                let lobby = to.and_then(Value::as_str) == Some("lobby");
                let room = to.and_then(Value::as_str) == Some("room");
                let key = to.and_then(|t| t.get("key")).and_then(Value::as_str).filter(|k| state::key_ok(k)).map(str::to_string);
                let whisper = to.and_then(|t| t.get("whisper")).and_then(Value::as_str).filter(|id| !id.is_empty() && id.len() <= 40).map(str::to_string);
                if key.as_ref().is_some_and(|k| self.banned_by.get(k).is_some_and(|b| b.2)) {
                    return self.page_error("banned", "that room keeps you out of its chat", Some("say"));
                }
                if to.is_some() && !lobby && !room && key.is_none() && whisper.is_none() {
                    return self.page_error("bad_message", "to is \"here\", \"room\", \"lobby\", { key } of an office linked with this one, or { whisper } an office's id", Some("say"));
                }
                if lobby && shares {
                    return self.page_error("not_supported", "the lobby carries text only: pictures and links go to rooms, and to those you are linked with", Some("say"));
                }
                // A whisper with pictures or links goes over a link with them, not through the lobby (8.12).
                let direct = whisper.as_deref().filter(|_| shares).map(|id| self.office_key(id).filter(|k| self.visits.values().any(|v| v.up && v.peer.get("key").and_then(Value::as_str) == Some(k.as_str()))));
                if let Some(None) = direct {
                    return self.page_error("no_link", "pictures and links go only to someone you are linked with", Some("say"));
                }
                if (lobby || (whisper.is_some() && direct.is_none())) && !(self.online && self.lobby_chat) {
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
                // As it goes (its pictures and links with it), and as it is kept (a lobby line comes back from the
                // lobby, and is kept then).
                let mut line = json!({ "key": self.key, "name": self.my_name(), "text": text });
                attach(&mut line, media, links);
                let mut mine = line.clone();
                mine["type"] = json!("chat");
                mine["scope"] = json!("say");
                mine["mine"] = json!(true);
                if let Some(id) = whisper {
                    let o = self.lobby_view.as_ref().and_then(|l| l.get("offices")).and_then(Value::as_array)
                        .and_then(|os| os.iter().find(|o| o.get("id").and_then(Value::as_str) == Some(id.as_str())).cloned()).unwrap_or(Value::Null);
                    mine["scope"] = json!("whisper");
                    mine["to"] = json!({ "id": id, "key": o.get("key"), "name": o.get("name") });
                    mine["conversation"] = json!(format!("person:{}", o.get("key").and_then(Value::as_str).map_or_else(|| format!("id:{id}"), str::to_string)));
                    match direct.flatten() {
                        Some(k) => {
                            let mut w = json!({ "text": text });
                            attach(&mut w, line["media"].as_array().cloned().unwrap_or_default(), line["links"].as_array().cloned().unwrap_or_default());
                            self.to_peer(&k, json!({ "whisper": w }));
                        }
                        None => self.to_lobby(json!({ "type": "whisper", "to": id, "text": text })),
                    }
                } else if let Some(k) = key {
                    let name = self.visits.values().find(|v| v.peer.get("key").and_then(Value::as_str) == Some(k.as_str())).and_then(|v| v.peer.get("name").cloned());
                    mine["scope"] = json!("sim");
                    mine["to"] = json!({ "key": k, "name": name });
                    mine["conversation"] = json!(format!("room:{k}"));
                    let mut ctl = json!({ "sim_say": text });
                    attach(&mut ctl, line["media"].as_array().cloned().unwrap_or_default(), line["links"].as_array().cloned().unwrap_or_default());
                    self.to_peer(&k, ctl);
                } else if lobby {
                    return self.to_lobby(json!({ "type": "chat", "text": text }));
                } else if room {
                    mine["scope"] = json!("sim");
                    mine["to"] = json!({ "key": self.key, "name": self.office.get("name") });
                    mine["conversation"] = json!(format!("room:{}", self.key));
                    self.room_said(&line, None);
                } else {
                    let host = self.visiting().and_then(|v| v.peer.get("key").and_then(Value::as_str)).unwrap_or(&self.key).to_string();
                    mine["conversation"] = json!(format!("room:{host}"));
                    self.say_out(line);
                }
                self.keep_chat(mine);
            }
            // A line one of this room's own figures says (8.9: a receptionist, a guide; none of them a person): `id` names
            // it (its object in the room's scene is `visit:npc:<id>`), `name` is what it goes by. Said in this office's
            // room, to everyone who can see it (its visitors, and those who have it in their worlds or corners), and kept
            // in its chat, never as this office's user: their own limit is untouched, each figure has one of its own.
            "say_as" => {
                let id = m.get("id").and_then(Value::as_str).filter(|id| link::possession_id_ok(id)).map(str::to_string);
                let name = m.get("name").and_then(Value::as_str).map(state::clip_name).map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
                let text = m.get("text").and_then(Value::as_str).map(said_text).unwrap_or_default();
                let (Some(id), Some(name)) = (id, name) else {
                    return self.page_error("bad_message", "id is 1 to 40 letters, digits, _ . or -, and name is not empty", Some("say_as"));
                };
                if text.is_empty() {
                    return self.page_error("bad_message", &format!("text is 1 to {SAY_LEN} characters"), Some("say_as"));
                }
                if !counted(self.npc_says.entry(id.clone()).or_insert((Instant::now(), 0))) {
                    return self.page_error("rate_limited", &format!("at most {SAYS} lines every {} s from each", SAY_WINDOW.as_secs()), Some("say_as"));
                }
                let line = json!({ "key": self.key, "name": name, "text": text, "npc": id });
                for v in self.visits.values().filter(|v| v.up && v.role == Role::Host && !self.chat_banned(v.peer.get("key").and_then(Value::as_str).unwrap_or(""))) {
                    let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "said": line })));
                }
                let mut chat = line;
                chat["type"] = json!("chat");
                chat["conversation"] = json!(format!("room:{}", self.key));
                self.to_page(chat);
            }
            // The name this office's user goes by (8.9; null: none, this office's own): told to every office linked
            // with it, and to each that links.
            "user" => {
                let name = m.get("name").and_then(Value::as_str).map(state::clip_name).map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
                if name == self.user_name {
                    return;
                }
                self.user_name = name.clone();
                for v in self.visits.values().filter(|v| v.up) {
                    let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "user": { "name": name } })));
                }
                self.tell_near();
                self.tell_voice_members();
            }
            // A picture the page would show (8.12): sent to it (a binary message, never dropped) once this office has
            // it, or `media_none`.
            "media_get" => match m.get("id").and_then(Value::as_str).filter(|id| media::id_ok(id)) {
                Some(id) => { let _ = self.db.send(DbCmd::GetMedia { id: id.to_string(), to: MediaTo::Page }); }
                None => self.page_error("bad_message", "id is a picture's id (64 hex characters)", Some("media_get")),
            },
            // A link's preview, made here (8.12: fetched once, by its sender): `preview` when made.
            "preview" => {
                let req = m.get("req").cloned().unwrap_or(Value::Null);
                let Some(url) = m.get("url").and_then(Value::as_str).filter(|u| media::url_ok(u)).map(str::to_string) else {
                    return self.page_error("bad_message", "url is an http or https link", Some("preview"));
                };
                let me = self.me.clone();
                tokio::task::spawn_blocking(move || {
                    let found = media::preview(&url);
                    let _ = me.send(Ev::Preview { req, url, found });
                });
            }
            // Lines before a moment (8.12: the chat's history, from the database), newest last.
            "history" => {
                let req = m.get("req").cloned().unwrap_or(Value::Null);
                let before = m.get("before").and_then(Value::as_i64).unwrap_or(i64::MAX);
                let limit = m.get("limit").and_then(Value::as_i64).unwrap_or(50).clamp(1, 200);
                let _ = self.db.send(DbCmd::History { req, before, limit });
            }
            // The pictures, or the links, shared in a conversation (8.12), newest first.
            "shared" => {
                let req = m.get("req").cloned().unwrap_or(Value::Null);
                let Some(conversation) = m.get("conversation").and_then(Value::as_str).filter(|c| c.len() <= 120 && (c.starts_with("room:") || c.starts_with("person:") || *c == "lobby")) else {
                    return self.page_error("bad_message", "conversation is room:<key>, person:<key> or lobby", Some("shared"));
                };
                let links = m.get("kind").and_then(Value::as_str) == Some("links");
                let before = m.get("before").and_then(Value::as_i64).unwrap_or(i64::MAX);
                let limit = m.get("limit").and_then(Value::as_i64).unwrap_or(60).clamp(1, 200);
                let _ = self.db.send(DbCmd::Shared { req, conversation: conversation.to_string(), links, before, limit });
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
                // Where this office's world has its friends at home in their own rooms (plots in it): [key, x, y, z].
                self.voice.world = m.get("world").and_then(Value::as_array).into_iter().flatten().take(64).filter_map(|e| {
                    let a = e.as_array().filter(|a| a.len() == 4)?;
                    Some((a[0].as_str().filter(|k| state::key_ok(k))?.to_string(), spot(Some(&json!(a[1..])))?))
                }).collect();
                self.world_near();
                self.tell_near();
            }
            // The room voice this office's user is in (8.7): a linked office's room's (its key), their own (this
            // office's key), or none (null).
            "voice_join" => {
                let key = m.get("key").and_then(Value::as_str).map(str::to_string);
                if let Some(k) = key.as_ref().filter(|k| **k != self.key) {
                    if !self.visits.values().any(|v| v.up && v.peer.get("key").and_then(Value::as_str) == Some(k.as_str())) {
                        return self.page_error("no_link", "no link with that office, either way", Some("voice_join"));
                    }
                    if self.banned_by.get(k).is_some_and(|b| b.1) {
                        return self.page_error("banned", "that room keeps you out of its voice", Some("voice_join"));
                    }
                }
                self.voice_join(key);
            }
            // One out of this office's room's voice, now (they may come back).
            "voice_kick" => {
                let key = m.get("key").and_then(Value::as_str).unwrap_or("").to_string();
                if self.voice_members.remove(&key).is_some() {
                    self.to_peer(&key, json!({ "voice_out": "kicked" }));
                    self.tell_voice_members();
                }
            }
            // Someone kept out of this office's room's voice, its chat, both, or neither (8.9): kept until lifted.
            "ban" => {
                let Some(key) = m.get("key").and_then(Value::as_str).filter(|k| state::key_ok(k) && **k != self.key).map(str::to_string) else {
                    return self.page_error("bad_message", "key is another office's key", Some("ban"));
                };
                let (voice, chat) = (m.get("voice") == Some(&json!(true)), m.get("chat") == Some(&json!(true)));
                let name = state::clip_name(m.get("name").and_then(Value::as_str)
                    .or_else(|| self.visits.values().find(|v| v.peer.get("key").and_then(Value::as_str) == Some(key.as_str())).and_then(|v| v.peer.get("name")).and_then(Value::as_str))
                    .unwrap_or(""));
                self.saved.bans.retain(|b| b.key != key);
                if voice || chat {
                    if self.saved.bans.len() >= state::MAX_GUESTS {
                        return self.page_error("too_many", "at most 256 kept out", Some("ban"));
                    }
                    self.saved.bans.push(state::Ban { key: key.clone(), name: name.clone(), voice, chat });
                }
                let _ = self.db.send(DbCmd::Ban(state::Ban { key: key.clone(), name, voice, chat }));
                self.to_page(json!({ "type": "bans", "bans": self.saved.bans_json() }));
                self.to_peer(&key, json!({ "banned": { "voice": voice, "chat": chat } }));
                if voice && self.voice_members.remove(&key).is_some() {
                    self.to_peer(&key, json!({ "voice_out": "banned" }));
                    self.tell_voice_members();
                }
                self.tell_near();
            }
            "avatar_want" => {
                let ch = m.get("channel").and_then(Value::as_u64).unwrap_or(0) as u16;
                match self.visits.values().find(|v| v.channel == ch && v.role == Role::Host && v.up) {
                    Some(v) => { let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "avatar_want": true }))); }
                    None => self.page_error("no_such_visit", "no visit to you on that channel", Some("avatar_want")),
                }
            }
            // How this room draws a visitor (host side, 8.6): as itself or as this room's model, its eyes over its feet
            // (scene units), and why not as itself, if it would be. To the visitor, which shows it in its own world.
            "body" => {
                let ch = m.get("channel").and_then(Value::as_u64).unwrap_or(0) as u16;
                let body = body_from(&m);
                match self.visits.values().find(|v| v.channel == ch && v.role == Role::Host && v.up) {
                    Some(v) => { let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "body": body }))); }
                    None => self.page_error("no_such_visit", "no visit to you on that channel", Some("body")),
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
        if let Some((slot, bytes)) = frames::media_from_page(data) {   // a picture to share (8.12): kept, and its id told
            return match media::picture(&bytes, media::MAX_MEDIA) {
                Some((id, mime)) => {
                    self.media_keep(&id, mime, &bytes);
                    self.to_page(json!({ "type": "media_ready", "slot": slot, "id": id, "mime": mime, "size": bytes.len() }));
                }
                None => self.to_page(json!({ "type": "error", "code": "bad_media", "ref": "media_put", "slot": slot,
                                              "message": format!("a picture is a PNG, JPEG, WebP or GIF of at most {} MB", media::MAX_MEDIA >> 20) })),
            };
        }
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

    fn to_page(&mut self, mut v: Value) {
        if v.get("type").and_then(Value::as_str) == Some("chat") {
            if v.get("conversation").is_none() {
                v["conversation"] = json!(self.conversation_of(&v));
            }
            self.keep_chat(v.clone());
        }
        if let Some(p) = &self.page {
            let _ = p.text.send(PageOut::Text(v.to_string()));   // gone: PageClosed follows
        }
    }

    /// A line of chat this office's user had, or said, with when (ms since 1970): kept in the database (8.12), and
    /// the last CHAT_KEPT here, for a page that comes back (8.9).
    fn keep_chat(&mut self, mut line: Value) {
        line["at"] = json!(db::now());
        if line.get("conversation").is_none() {
            line["conversation"] = json!(self.conversation_of(&line));
        }
        if self.chat.len() >= CHAT_KEPT {
            self.chat.pop_front();
        }
        self.chat.push_back(line.clone());
        let _ = self.db.send(DbCmd::Line(line));
    }

    /// The conversation a line is in (8.12): a room's ("room:<its owner's key>": said in it, or in its chat), a
    /// person's ("person:<their key>": whispers), or the lobby's.
    fn conversation_of(&self, m: &Value) -> String {
        let peer = m.get("channel").and_then(Value::as_u64).and_then(|ch| self.visits.values().find(|v| u64::from(v.channel) == ch))
            .map(|v| (v.role, v.peer.get("key").and_then(Value::as_str).unwrap_or("").to_string()));
        match m.get("scope").and_then(Value::as_str) {
            Some("lobby") => "lobby".into(),
            Some("whisper") => format!("person:{}", m.get("key").and_then(Value::as_str).filter(|k| !k.is_empty()).map_or_else(|| format!("id:{}", m["id"].as_str().unwrap_or("")), str::to_string)),
            Some("sim") if m.get("home") != Some(&json!(true)) => format!("room:{}", peer.map_or_else(|| self.key.clone(), |(_, k)| k)),
            Some("sim") => format!("room:{}", self.key),
            _ => match peer {
                Some((Role::Visitor, k)) => format!("room:{k}"),   // said in the room this office's user is in, or sees
                _ => format!("room:{}", self.key),
            },
        }
    }

    // ---------- pictures (8.12): kept in the database, asked for over the link a line came by ----------

    /// The pictures a line names that came over a link (`visit`): each this office does not have is asked of that
    /// link, once (meanwhile, whoever asks for it here waits for it).
    fn want_media(&mut self, line: &Value, visit: &str) {
        for id in media_ids(line) {
            if !self.media_asked.contains_key(&id) {
                self.media_asked.insert(id.clone(), (Instant::now(), visit.to_string(), false));
                let _ = self.db.send(DbCmd::HasMedia { id, visit: visit.to_string() });
            }
        }
    }

    fn db_has(&mut self, id: String, visit: &str, has: bool) {
        if has {
            self.media_asked.remove(&id);
            for to in self.media_waiting.remove(&id).unwrap_or_default() {
                let _ = self.db.send(DbCmd::GetMedia { id: id.clone(), to });
            }
        } else if let Some(a) = self.media_asked.get_mut(&id) {
            *a = (Instant::now(), visit.to_string(), true);
            if let Some(v) = self.visits.get(visit).filter(|v| v.up) {
                let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "media_want": id })));
            }
        }
    }

    /// A picture kept: in the database, and (the last few) here, for whoever asks while the database takes it.
    fn media_keep(&mut self, id: &str, mime: &str, bytes: &Bytes) {
        let _ = self.db.send(DbCmd::PutMedia { id: id.to_string(), mime: mime.to_string(), bytes: bytes.clone() });
        if self.media_recent.len() >= MEDIA_RECENT {
            self.media_recent.pop_front();
        }
        self.media_recent.push_back((id.to_string(), mime.to_string(), bytes.clone()));
    }

    /// A picture this office asked for, come: kept, and to whoever waits for it. One not asked for is dropped.
    fn media_in(&mut self, visit: &str, id: String, mime: String, bytes: Bytes) {
        if self.media_asked.remove(&id).is_none() {
            return debug!(visit, "a picture not asked for: dropped");
        }
        self.media_keep(&id, &mime, &bytes);
        for to in self.media_waiting.remove(&id).unwrap_or_default() {
            self.media_to(&to, &id, &mime, &bytes);
        }
    }

    /// The database's answer for a picture asked for: to whoever asked; none, and coming, they wait; none, and not
    /// coming, they are told (`media_none`).
    fn db_media(&mut self, id: String, to: MediaTo, found: Option<(String, Bytes)>) {
        let recent = self.media_recent.iter().find(|(i, _, _)| *i == id).map(|(_, m, b)| (m.clone(), b.clone()));
        match found.or(recent) {
            Some((mime, bytes)) => self.media_to(&to, &id, &mime, &bytes),
            None if self.media_asked.contains_key(&id) => self.media_waiting.entry(id).or_default().push(to),
            None => self.media_none_to(&to, &id),
        }
    }

    fn media_to(&mut self, to: &MediaTo, id: &str, mime: &str, bytes: &Bytes) {
        match to {
            MediaTo::Page => {
                if let Some(p) = &self.page {
                    let _ = p.text.send(PageOut::Binary(frames::media_to_page(id, mime, bytes)));
                }
            }
            MediaTo::Link(visit) => {
                if let Some(v) = self.visits.get(visit).filter(|v| v.up) {
                    let _ = v.cmd.try_send(LinkCmd::Media { id: id.to_string(), mime: mime.to_string(), bytes: bytes.clone() });
                }
            }
        }
    }

    fn media_none_to(&mut self, to: &MediaTo, id: &str) {
        match to {
            MediaTo::Page => self.to_page(json!({ "type": "media_none", "id": id })),
            MediaTo::Link(visit) => {
                if let Some(v) = self.visits.get(visit).filter(|v| v.up) {
                    let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "media_none": id })));
                }
            }
        }
    }

    /// A picture asked for that will not come (the other side has none, or did not answer in a minute): whoever
    /// waits for it is told.
    fn media_gone(&mut self, id: &str) {
        self.media_asked.remove(id);
        for to in self.media_waiting.remove(id).unwrap_or_default() {
            self.media_none_to(&to, id);
        }
    }

    fn media_expire(&mut self) {
        let old: Vec<String> = self.media_asked.iter().filter(|(_, (at, _, _))| at.elapsed() >= Duration::from_secs(60)).map(|(id, _)| id.clone()).collect();
        for id in old {
            self.media_gone(&id);
        }
    }

    /// A link's preview, made: its picture kept (a picture's id), and to the page.
    fn preview_in(&mut self, req: Value, url: String, found: Option<media::Preview>) {
        let Some(p) = found else {
            return self.to_page(json!({ "type": "preview", "req": req, "url": url, "none": true }));
        };
        let image = p.image.and_then(|b| {
            let (id, mime) = media::picture(&b, media::MAX_MEDIA)?;
            self.media_keep(&id, mime, &b);
            Some(json!({ "id": id, "mime": mime, "size": b.len() }))
        });
        self.to_page(json!({ "type": "preview", "req": req, "url": url, "title": p.title, "description": p.description, "site": p.site, "image": image }));
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

    /// This office's user's voice, from its page, where it may go (`allowed`): in person (the room they are in:
    /// another's, to its owner, whose visit-client decides; their own, to each visitor near them; and across a plot's
    /// side, to each friend near them in both worlds), to a call (to the ear, always; on speaker, if they are near the
    /// phone), and to the room voice they are in. It goes each way it may: which way each hears it is theirs to
    /// choose (8.7: in person first, then a call, then a room voice).
    fn voice_out(&mut self, allowed: u16, voice: Bytes) {
        let away = self.visits.values().find(|v| v.up && v.role == Role::Visitor && v.inside).map(|v| v.channel);
        let me = if away.is_some() { None } else { self.voice.me };
        let mut to: Vec<u16> = Vec::new();
        if allowed & frames::VOICE_ROOM != 0 {
            to.extend(away);
            if let Some(me) = me {
                to.extend(self.within(me, VOICE_RANGE + VOICE_MARGIN, None));
                for key in self.voice.world_told.iter().filter(|k| self.voice.world_heard.contains(*k) && !self.voice_banned(k)) {
                    to.extend(self.link_with(key));
                }
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
        if allowed & frames::VOICE_CHANNEL != 0 {
            let Some(room) = self.room_voice.clone() else { return };
            let head = frames::relay_head(&self.key, self.my_name().as_str().unwrap_or(""), &voice);
            if room == self.key {   // this office's own room's voice: to everyone in it
                for key in self.voice_members.keys() {
                    self.voice_to(key, false, &head);
                }
            } else {
                self.voice_to(&room, true, &head);
            }
        }
    }

    /// A packet of voice over a link (`relayed`: someone else's, passed on, with who spoke), heard one way only (8.7):
    /// in person first, then on a call. In person: the room this office's user is in (its owner, or one passed on); a
    /// visitor in this room (to the page if this office's user is near them, to the other visitors near them, and to
    /// a call on speaker if they are near the phone); a friend across a plot's side, near in both worlds. A call's: to
    /// the page, unless its caller is heard in person; on speaker, also to this room's visitors near the phone, as the
    /// phone's. Else nowhere.
    fn voice_in(&mut self, id: &str, data: Bytes, relayed: bool) {
        let Some(v) = self.visits.get(id).filter(|v| v.up) else { return };
        let (ch, role, inside, call_on, speaker, visit) = (v.channel, v.role, v.inside, v.call_on, v.speaker, v.id.clone());
        let name = person(v).as_str().unwrap_or("").to_string();
        let key = v.peer.get("key").and_then(Value::as_str).unwrap_or("").to_string();
        let near = !relayed && self.in_person(&key);
        if role == Role::Visitor && inside {   // the room this office's user is in: its owner's voice, or one passed on
            let route = if call_on && !relayed && !near { frames::ROUTE_CALL } else { frames::ROUTE_NEAR };
            return self.voice_to_page(ch, route, &data, relayed);
        }
        if role == Role::Host && inside && !relayed && !self.voice_banned(&key) {   // a visitor in this room
            if let Some(at) = self.voice.visitors.get(&ch).copied() {   // where the room has them: not said yet, nobody hears
                if (!call_on || near) && self.voice.me.is_some_and(|me| flat(me, at) <= VOICE_RANGE + VOICE_MARGIN) {
                    self.voice_to_page(ch, frames::ROUTE_NEAR, &data, false);
                }
                let mut to = self.within(at, VOICE_RANGE + VOICE_MARGIN, Some(ch));
                if self.voice.phone.is_some_and(|p| flat(p, at) <= VOICE_RANGE) {   // a call on speaker hears those near the phone
                    to.extend(self.visits.values().filter(|c| c.up && c.call_on && c.speaker && c.channel != ch).map(|c| c.channel));
                }
                self.relay_to(&to, frames::relay_head(&visit, &name, &data));
            }
        } else if !relayed && self.seam(&key) && !self.voice_banned(&key) && (!call_on || near) {   // across a plot's side
            return self.voice_to_page(ch, frames::ROUTE_NEAR, &data, false);
        }
        if !call_on || near {   // no call; or its caller heard in person, and the call goes quiet for them
            return;
        }
        self.voice_to_page(ch, frames::ROUTE_CALL, &data, relayed);
        if let Some(phone) = self.voice.phone.filter(|_| speaker) {
            let head = if relayed {
                let Some((who, said, voice)) = frames::relay_parts(&data) else { return };
                frames::relay_head(&format!("phone:{who}"), &said, voice)
            } else {
                frames::relay_head("phone", &name, &data)
            };
            self.relay_to(&self.within(phone, VOICE_RANGE + VOICE_MARGIN, Some(ch)), head);
        }
    }

    /// A packet of a room voice (8.7). Up, from one in this office's room's voice: to everyone else in it, and to the
    /// page if this office's user is in it. Down, from the room whose voice this office's user is in: to the page.
    /// Each unless its speaker is heard another way (in person, or on a call).
    fn room_voice_in(&mut self, id: &str, up: bool, data: Bytes) {
        let Some(v) = self.visits.get(id).filter(|v| v.up) else { return };
        let ch = v.channel;
        let key = v.peer.get("key").and_then(Value::as_str).unwrap_or("").to_string();
        let name = person(v).as_str().unwrap_or("").to_string();
        let Some((who, _, voice)) = frames::relay_parts(&data) else { return };
        if up {
            if !self.voice_members.contains_key(&key) || self.voice_banned(&key) {
                return;
            }
            let head = frames::relay_head(&key, &name, voice);
            for m in self.voice_members.keys().filter(|m| **m != key) {
                self.voice_to(m, false, &head);
            }
            if self.room_voice.as_deref() == Some(self.key.as_str()) && !self.in_person(&key) && !self.on_call(&key) {
                self.voice_to_page(ch, frames::ROUTE_VOICE, &head, true);
            }
        } else if self.room_voice.as_deref() == Some(key.as_str()) && who != self.key && !self.in_person(&who) && !self.on_call(&who) {
            self.voice_to_page(ch, frames::ROUTE_VOICE, &data, true);
        }
    }

    /// A room voice's packet (who spoke, and the voice) to the office with this key, over one link up with it: to its
    /// room (`up`), or from this office's.
    fn voice_to(&self, key: &str, up: bool, head: &Bytes) {
        if let Some(v) = self.visits.values().find(|v| v.up && v.peer.get("key").and_then(Value::as_str) == Some(key)) {
            let _ = v.cmd.try_send(LinkCmd::Voice { up, data: head.clone() });
        }
    }

    /// The channel of a link up with the office with this key: one with a call on, if there is one (a packet then
    /// goes once, for both).
    fn link_with(&self, key: &str) -> Option<u16> {
        let links = || self.visits.values().filter(move |v| v.up && v.peer.get("key").and_then(Value::as_str) == Some(key));
        links().find(|v| v.call_on).or_else(|| links().next()).map(|v| v.channel)
    }

    /// Whether this office's user hears the user of the office with this key in person (8.7): within VOICE_RANGE in
    /// the room they are in (a visitor near them at home; in another's room, as its owner says), or across a plot's
    /// side, near in both worlds. Then a call or a room voice with them goes quiet.
    fn in_person(&self, key: &str) -> bool {
        if key.is_empty() || self.voice_banned(key) {
            return false;
        }
        if let Some(v) = self.visiting() {
            return v.near_keys.iter().any(|k| k == key);
        }
        let Some(me) = self.voice.me else { return false };
        self.visits.values().any(|v| v.up && v.role == Role::Host && v.inside && v.peer.get("key").and_then(Value::as_str) == Some(key)
            && self.voice.visitors.get(&v.channel).is_some_and(|p| flat(*p, me) <= VOICE_RANGE))
            || (self.seam(key) && self.voice.world.get(key).is_some_and(|p| flat(*p, me) <= VOICE_RANGE))
    }

    /// Near each other across a plot's side (8.7): both at home, each within reach of the other in its own world.
    fn seam(&self, key: &str) -> bool {
        self.voice.world_told.contains(key) && self.voice.world_heard.contains(key)
    }

    fn on_call(&self, key: &str) -> bool {
        self.visits.values().any(|v| v.up && v.call_on && v.peer.get("key").and_then(Value::as_str) == Some(key))
    }

    /// Kept out of this office's room's voice, or its chat (8.9).
    fn voice_banned(&self, key: &str) -> bool {
        self.saved.bans.iter().any(|b| b.voice && b.key == key)
    }

    fn chat_banned(&self, key: &str) -> bool {
        self.saved.bans.iter().any(|b| b.chat && b.key == key)
    }

    /// Who this office's world has within reach of its user, both at home (8.7: across a plot's side): each told when
    /// that changes, over a link with them (and again over each that comes up).
    fn world_near(&mut self) {
        let me = if self.visiting().is_some() { None } else { self.voice.me };
        let now: HashSet<String> = me.map(|me| self.voice.world.iter().filter(|(_, p)| flat(**p, me) <= VOICE_RANGE + VOICE_MARGIN).map(|(k, _)| k.clone()).collect())
            .unwrap_or_default();
        for k in now.difference(&self.voice.world_told) {
            self.to_peer(k, json!({ "world_near": true }));
        }
        for k in self.voice.world_told.difference(&now) {
            self.to_peer(k, json!({ "world_near": false }));
        }
        self.voice.world_told = now;
    }

    /// Into a room voice (8.7), out of the one this office's user was in: a linked office's room's (it says who is in
    /// it), their own (everyone in it told), or none.
    fn voice_join(&mut self, key: Option<String>) {
        if self.room_voice == key {
            return;
        }
        match self.room_voice.take() {
            Some(old) if old == self.key => self.tell_voice_members(),
            Some(old) => {
                self.to_peer(&old, json!({ "voice_join": false }));
            }
            None => {}
        }
        self.room_voice = key.clone();
        match key {
            Some(k) if k == self.key => self.tell_voice_members(),
            Some(k) => {
                self.to_peer(&k, json!({ "voice_join": true }));
            }
            None => self.to_page(json!({ "type": "room_voice", "key": null })),
        }
    }

    /// Who is in this office's room's voice (8.7): its own user (if they are), and each member; told to each member,
    /// and to the page (`voice_members`; and `room_voice`, if its user is in it).
    fn tell_voice_members(&mut self) {
        let list = self.voice_members_json();
        for k in self.voice_members.keys() {
            self.to_peer(k, json!({ "voice_members": list }));
        }
        self.to_page(json!({ "type": "voice_members", "members": list }));
        if self.room_voice.as_deref() == Some(self.key.as_str()) {
            self.to_page(json!({ "type": "room_voice", "key": self.key, "name": self.office.get("name"), "members": list }));
        }
    }

    fn voice_members_json(&self) -> Value {
        let mut list: Vec<Value> = Vec::new();
        if self.room_voice.as_deref() == Some(self.key.as_str()) {
            list.push(json!({ "key": self.key, "name": self.my_name() }));
        }
        list.extend(self.voice_members.iter().map(|(k, n)| json!({ "key": k, "name": n })));
        json!(list)
    }

    /// The room voice this office's user is in, for a page that connects: its room (who is in it comes again).
    fn room_voice_json(&self) -> Value {
        match &self.room_voice {
            None => Value::Null,
            Some(k) if *k == self.key => json!({ "key": k, "name": self.office.get("name"), "members": self.voice_members_json() }),
            Some(k) => {
                let name = self.visits.values().find(|v| v.peer.get("key").and_then(Value::as_str) == Some(k.as_str())).and_then(|v| v.peer.get("name").cloned());
                json!({ "key": k, "name": name, "members": null })
            }
        }
    }

    fn banned_by_json(&self) -> Value {
        json!(self.banned_by.iter().map(|(k, (name, voice, chat))| json!({ "key": k, "name": name, "voice": voice, "chat": chat })).collect::<Vec<_>>())
    }

    fn voice_to_page(&self, ch: u16, route: u8, data: &[u8], relayed: bool) {
        if let Some(p) = &self.page {   // a page behind loses some: late is lost
            let _ = p.frames.try_send(if relayed { frames::relay_to_page(ch, route, data) } else { frames::audio_to_page(ch, route, data) });
        }
    }

    fn relay_to(&self, channels: &[u16], head: Bytes) {
        for v in self.visits.values().filter(|v| v.up && channels.contains(&v.channel)) {
            let _ = v.cmd.try_send(LinkCmd::Relay(head.clone()));
        }
    }

    /// The channels of this room's visitors within `reach` metres of a spot (as the room has them), but one.
    fn within(&self, at: [f64; 3], reach: f64, but: Option<u16>) -> Vec<u16> {
        self.visits.values().filter(|v| v.up && v.role == Role::Host && v.inside && Some(v.channel) != but && !self.voice_banned(v.peer.get("key").and_then(Value::as_str).unwrap_or("")))
            .filter(|v| self.voice.visitors.get(&v.channel).is_some_and(|p| flat(*p, at) <= reach))
            .map(|v| v.channel).collect()
    }

    /// Who is near whom in this room (within VOICE_RANGE), for each to know: this office's page (`voice_near`)
    /// and each visitor in it (`near`, over its link); with a call on speaker, its caller for those near the
    /// phone. Told when it changes; their distances, at most every NEAR_EVERY.
    fn tell_near(&mut self) {
        let me_entry = json!({ "key": self.key, "name": self.my_name() });
        let mut people: Vec<(u16, [f64; 3], Value)> = self.voice.me.map(|me| (0, me, me_entry)).into_iter().collect();
        for v in self.visits.values().filter(|v| v.up && v.role == Role::Host && v.inside && !self.voice_banned(v.peer.get("key").and_then(Value::as_str).unwrap_or(""))) {
            if let Some(at) = self.voice.visitors.get(&v.channel) {
                people.push((v.channel, *at, json!({ "key": v.peer.get("key"), "name": person(v), "id": v.id })));
            }
        }
        let caller = self.visits.values().find(|v| v.up && v.call_on && v.speaker).map(person);
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
        if let Some(me) = self.voice.me {   // across a plot's side (8.7): friends near in both worlds, for this office's page
            if let Some((_, near)) = lists.iter_mut().find(|(c, _)| *c == 0) {
                for (key, p) in self.voice.world.iter().filter(|(k, p)| self.seam(k) && flat(**p, me) <= VOICE_RANGE) {
                    let name = self.visits.values().find(|v| v.peer.get("key").and_then(Value::as_str) == Some(key.as_str())).map(person);
                    near.push(json!({ "key": key, "name": name, "distance": flat(*p, me).round(), "world": true }));
                }
            }
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
    fn say_out(&mut self, line: Value) {
        if let Some(v) = self.visits.values().find(|v| v.up && v.role == Role::Visitor && v.inside) {
            let mut ctl = json!({ "say": line["text"] });
            attach(&mut ctl, line["media"].as_array().cloned().unwrap_or_default(), line["links"].as_array().cloned().unwrap_or_default());
            let _ = v.cmd.try_send(LinkCmd::Ctl(ctl));
            return;
        }
        let mut line = line;
        line["owner"] = json!(true);
        for v in self.visits.values().filter(|v| v.up && v.role == Role::Host && !self.chat_banned(v.peer.get("key").and_then(Value::as_str).unwrap_or(""))) {
            let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "said": line })));
        }
    }

    /// A line a visitor in this room said: to this office's page, and to everyone else who can see this room (its other
    /// visitors, and those who have it in their worlds or corners).
    fn say_in(&mut self, from: u16, line: Value) {
        if self.chat_banned(line["key"].as_str().unwrap_or("")) {   // kept out of this room's chat
            return;
        }
        for v in self.visits.values().filter(|v| v.up && v.role == Role::Host && v.channel != from && !self.chat_banned(v.peer.get("key").and_then(Value::as_str).unwrap_or(""))) {
            let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "said": line })));
        }
        let mut chat = line;
        chat["type"] = json!("chat");
        chat["channel"] = json!(from);
        self.to_page(chat);
    }

    /// A line said in this office's room's chat (8.9: by its own user, or into it from a linked office): to every office
    /// linked with it, either way (in it, watching it, or seen from it), once each, but its sayer's. One in the room has
    /// it on its visit there.
    fn room_said(&self, line: &Value, sayer: Option<&str>) {
        let mut links: Vec<&Visit> = self.visits.values().filter(|v| v.up).collect();
        links.sort_by_key(|v| match v.role {
            Role::Host if v.inside => 0,
            Role::Host => 1,
            Role::Visitor => 2,
        });
        let mut told = HashSet::new();
        for v in links {
            let Some(key) = v.peer.get("key").and_then(Value::as_str) else { continue };
            if Some(key) != sayer && !self.chat_banned(key) && told.insert(key) {
                let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "sim_said": line })));
            }
        }
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
                    // By the name they go by, if a link with them says it (the lobby knows offices only)
                    let user = key.as_deref().and_then(|k| self.visits.values().find(|v| v.peer.get("key").and_then(Value::as_str) == Some(k) && v.peer_user.is_some())).map(person);
                    let name = user.unwrap_or_else(|| json!(s(&from["name"], 24).unwrap_or_default()));
                    self.to_page(json!({ "type": "chat", "scope": scope, "id": id, "key": key, "name": name, "text": text }));
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
                    landscapes: false, land_sent: None, land_hash: None, near_keys: Vec::new(), peer_user: None,
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
        // Their last link gone: where they had put this office is no longer told, nor known; nor what is between them
        // by voice (8.7) and chat (8.9).
        if let Some(key) = v.peer.get("key").and_then(Value::as_str) {
            if !self.visits.values().any(|o| o.peer.get("key").and_then(Value::as_str) == Some(key)) {
                if self.seen_in.remove(key).is_some() {
                    self.to_page(json!({ "type": "seen", "key": key, "name": v.peer.get("name"), "at": null }));
                }
                self.voice.world_heard.remove(key);
                self.voice.world_told.remove(key);
                if self.voice_members.remove(key).is_some() {
                    self.tell_voice_members();
                }
                if self.room_voice.as_deref() == Some(key) {
                    self.room_voice = None;
                    self.to_page(json!({ "type": "room_voice", "key": null, "out": { "key": key, "name": v.peer.get("name"), "why": "gone" } }));
                }
                if self.banned_by.remove(key).is_some() {
                    self.to_page(json!({ "type": "banned", "key": key, "name": v.peer.get("name"), "voice": false, "chat": false }));
                }
                self.tell_near();
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

    /// The name this office's user goes by (8.9): theirs, as their page said, else this office's.
    fn my_name(&self) -> Value {
        self.user_name.clone().map_or_else(|| self.office.get("name").cloned().unwrap_or(Value::Null), Value::from)
    }

    /// The names the users of offices linked with this one go by, for a page that connects (8.9).
    fn users_json(&self) -> Value {
        let mut seen = HashSet::new();
        json!(self.visits.values().filter(|v| v.up && v.peer_user.is_some())
            .filter_map(|v| v.peer.get("key").and_then(Value::as_str).filter(|k| seen.insert(k.to_string())).map(|k| json!({ "key": k, "name": v.peer_user })))
            .collect::<Vec<_>>())
    }

    /// The lobby's id of the office with this key, if it is in the lobby.
    fn office_id_of(&self, key: &str) -> Option<String> {
        self.lobby_view.as_ref()?.get("offices")?.as_array()?.iter()
            .find(|o| o.get("key").and_then(Value::as_str) == Some(key))?
            .get("id").and_then(Value::as_str).map(str::to_string)
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
        let key = v.peer.get("key").and_then(Value::as_str).unwrap_or("").to_string();
        if self.voice.world_told.contains(&key) {   // near in this world, both at home (8.7)
            let _ = cmd.try_send(LinkCmd::Ctl(json!({ "world_near": true })));
        }
        if let Some(b) = self.saved.bans.iter().find(|b| b.key == key) {   // kept out of this room's voice or chat (8.9)
            let _ = cmd.try_send(LinkCmd::Ctl(json!({ "banned": { "voice": b.voice, "chat": b.chat } })));
        }
        if let Some(name) = &self.user_name {   // the name this office's user goes by (8.9)
            let _ = cmd.try_send(LinkCmd::Ctl(json!({ "user": { "name": name } })));
        }
        if self.room_voice.as_deref() == Some(key.as_str()) {   // in its room's voice: still
            let _ = cmd.try_send(LinkCmd::Ctl(json!({ "voice_join": true })));
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
        if let Some(text) = m.get("sim_say").and_then(Value::as_str).map(said_text) {   // a line said into this room from a linked office (8.9)
            let (media, links) = media::attachments(&m);
            if (text.is_empty() && media.is_empty() && links.is_empty()) || !counted(&mut v.says) {
                return;
            }
            let (key, name) = (v.peer.get("key").cloned().unwrap_or(Value::Null), person(v));
            if self.chat_banned(key.as_str().unwrap_or("")) {   // kept out of this room's chat
                return;
            }
            let mut line = json!({ "key": key, "name": name, "text": text });
            attach(&mut line, media, links);
            self.want_media(&line, id);
            self.room_said(&line, key.as_str());
            let mut chat = line;
            chat["type"] = json!("chat");
            chat["scope"] = json!("sim");
            chat["home"] = json!(true);
            chat["channel"] = json!(ch);
            return self.to_page(chat);
        }
        if let Some(w) = m.get("whisper").filter(|w| w.is_object()) {   // whispered over a link, with pictures or links (8.12)
            let text = w.get("text").and_then(Value::as_str).map(said_text).unwrap_or_default();
            let (media, links) = media::attachments(w);
            if (text.is_empty() && media.is_empty() && links.is_empty()) || !counted(&mut v.says) {
                return;
            }
            let (key, name) = (v.peer.get("key").and_then(Value::as_str).unwrap_or("").to_string(), person(v));
            let mut line = json!({ "type": "chat", "scope": "whisper", "id": self.office_id_of(&key), "key": key, "name": name, "text": text });
            attach(&mut line, media, links);
            self.want_media(&line, id);
            return self.to_page(line);
        }
        if let Some(mid) = m.get("media_want").and_then(Value::as_str).filter(|i| media::id_ok(i)) {   // a picture this office passed on (8.12)
            let _ = self.db.send(DbCmd::GetMedia { id: mid.to_string(), to: MediaTo::Link(id.to_string()) });
            return;
        }
        if let Some(mid) = m.get("media_none").and_then(Value::as_str).filter(|i| media::id_ok(i)) {   // one the other side does not have
            if self.media_asked.get(mid).is_some_and(|a| a.1 == id) {
                self.media_gone(mid);
            }
            return;
        }
        if let Some(u) = m.get("user") {   // the name the other office's user goes by (8.9), or none now
            v.peer_user = u.get("name").and_then(Value::as_str).map(state::clip_name).map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
            let (key, user) = (v.peer.get("key").and_then(Value::as_str).unwrap_or("").to_string(), person(v));
            if let Some(n) = self.voice_members.get_mut(&key) {
                *n = user.clone();
                self.tell_voice_members();
            }
            self.to_page(json!({ "type": "user", "key": key, "name": user }));
            return self.tell_near();
        }
        let (key, name, user) = (v.peer.get("key").and_then(Value::as_str).unwrap_or("").to_string(), v.peer.get("name").cloned().unwrap_or(Value::Null), person(v));
        if let Some(near) = m.get("world_near").and_then(Value::as_bool) {   // the other office has this one within reach in its world, both at home (8.7)
            if near { self.voice.world_heard.insert(key) } else { self.voice.world_heard.remove(&key) };
            return self.tell_near();
        }
        if let Some(on) = m.get("voice_join").and_then(Value::as_bool) {   // into this office's room's voice, or out of it (8.7)
            if on && self.voice_banned(&key) {
                self.to_peer(&key, json!({ "voice_out": "banned" }));
                return;
            }
            let changed = if on { self.voice_members.insert(key, user).is_none() } else { self.voice_members.remove(&key).is_some() };
            if changed || on {
                self.tell_voice_members();
            }
            return;
        }
        if let Some(list) = m.get("voice_members").and_then(Value::as_array) {   // who is in the room voice this office's user is in
            if self.room_voice.as_deref() == Some(key.as_str()) {
                let members: Vec<Value> = list.iter().take(64).filter_map(|e| {
                    Some(json!({ "key": e.get("key").and_then(Value::as_str).filter(|k| state::key_ok(k))?, "name": state::clip_name(e.get("name").and_then(Value::as_str).unwrap_or("")) }))
                }).collect();
                self.to_page(json!({ "type": "room_voice", "key": key, "name": name, "members": members }));
            }
            return;
        }
        if let Some(why) = m.get("voice_out").and_then(Value::as_str) {   // out of that room's voice: kicked, or kept out
            if self.room_voice.as_deref() == Some(key.as_str()) {
                self.room_voice = None;
                let why = if why == "banned" { "banned" } else { "kicked" };
                self.to_page(json!({ "type": "room_voice", "key": null, "out": { "key": key, "name": name, "why": why } }));
            }
            return;
        }
        if let Some(b) = m.get("banned") {   // that room keeps this office's user out of its voice, its chat, or neither now (8.9)
            let (voice, chat) = (b.get("voice") == Some(&json!(true)), b.get("chat") == Some(&json!(true)));
            if voice || chat { self.banned_by.insert(key.clone(), (name.clone(), voice, chat)); } else { self.banned_by.remove(&key); }
            if voice && self.room_voice.as_deref() == Some(key.as_str()) {
                self.room_voice = None;
                self.to_page(json!({ "type": "room_voice", "key": null, "out": { "key": key, "name": name, "why": "banned" } }));
            }
            return self.to_page(json!({ "type": "banned", "key": key, "name": name, "voice": voice, "chat": chat }));
        }
        if let Some(line) = m.get("sim_said").and_then(said_from) {   // a line said in the other office's room's chat (8.9)
            self.want_media(&line, id);
            let mut chat = line;
            chat["type"] = json!("chat");
            chat["scope"] = json!("sim");
            chat["channel"] = json!(ch);
            if let Some(o) = chat.as_object_mut() {
                o.remove("id");
                o.remove("owner");
            }
            return self.to_page(chat);
        }
        if let Some(at) = m.get("seen") {   // where the other office has put this one in its world (or nowhere): to the page
            if key.is_empty() {
                return;
            }
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
                if m.get("avatar_none") == Some(&json!(true)) {   // asked for its avatar, the visitor has none (8.6)
                    self.to_page(json!({ "type": "avatar_none", "channel": ch }));
                } else if let Some(list) = m.get("possessions") {   // what the visitor owns (8.11): checked, kept, to the page
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
                } else if let Some(text) = m.get("say").filter(|_| v.inside).and_then(Value::as_str).map(said_text) {
                    let (media, links) = media::attachments(&m);
                    if (!text.is_empty() || !media.is_empty() || !links.is_empty()) && counted(&mut v.says) {
                        let mut line = json!({ "key": v.peer.get("key"), "name": person(v), "id": v.id, "text": text });
                        attach(&mut line, media, links);
                        self.want_media(&line, id);
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
                    match self.avatar.clone() {
                        Some(gz) => { let _ = v.cmd.try_send(LinkCmd::Avatar(gz)); }
                        None => { let _ = v.cmd.try_send(LinkCmd::Ctl(json!({ "avatar_none": true }))); }   // (it goes once one is given)
                    }
                } else if let Some(b) = m.get("body") {   // how the host's room draws this office's user there (8.6)
                    let mut b = body_from(b);
                    b["type"] = json!("body");
                    b["channel"] = json!(ch);
                    self.to_page(b);
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
                    self.want_media(&line, id);
                    let mut line = line;
                    line["type"] = json!("chat");
                    line["channel"] = json!(ch);
                    self.to_page(line);
                } else if let Some(near) = m.get("near").filter(|_| v.inside) {   // who is near this office's user in the host's room (8.7)
                    let near = near_from(near);
                    v.near_keys = near.as_array().into_iter().flatten().filter_map(|e| e["key"].as_str().map(str::to_string)).collect();
                    self.to_page(json!({ "type": "voice_near", "channel": ch, "near": near }));
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
    let t = said_text(text);
    (!t.is_empty()).then_some(t)
}

/// A line's text, checked: control characters as spaces, trimmed, at most SAY_LEN characters; empty if none (a
/// line may be pictures or links alone).
fn said_text(text: &str) -> String {
    let t: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().trim().chars().take(SAY_LEN).collect();
    t.trim_end().to_string()
}

/// The name the other office's user goes by (8.9): theirs, if they said one (`user`), else their office's.
fn person(v: &Visit) -> Value {
    v.peer_user.clone().map_or_else(|| v.peer.get("name").cloned().unwrap_or(Value::Null), Value::from)
}

/// A line's pictures and links (8.12), set on it if it has any.
fn attach(line: &mut Value, media: Vec<Value>, links: Vec<Value>) {
    if !media.is_empty() {
        line["media"] = json!(media);
    }
    if !links.is_empty() {
        line["links"] = json!(links);
    }
}

/// The pictures a line names: its own, and its links' previews'.
fn media_ids(line: &Value) -> Vec<String> {
    let mut ids: Vec<String> = line["media"].as_array().into_iter().flatten().filter_map(|p| p["id"].as_str().map(str::to_string)).collect();
    ids.extend(line["links"].as_array().into_iter().flatten().filter_map(|l| l["image"]["id"].as_str().map(str::to_string)));
    ids
}

/// A line the host says was said in its room, checked: who (a key, a name; a visitor's visit id there, one of the
/// room's own figures, or the room's owner) and what.
fn said_from(v: &Value) -> Option<Value> {
    let s = |x: &Value, n: usize| x.as_str().map(|s| s.chars().filter(|c| !c.is_control()).take(n).collect::<String>());
    let text = said_text(v["text"].as_str().unwrap_or(""));
    let (media, links) = media::attachments(v);
    if text.is_empty() && media.is_empty() && links.is_empty() {
        return None;
    }
    let mut out = json!({ "key": s(&v["key"], 100)?, "name": s(&v["name"], 24).unwrap_or_default(), "text": text });
    attach(&mut out, media, links);
    if let Some(id) = s(&v["id"], 40) {
        out["id"] = json!(id);
    } else if let Some(npc) = v["npc"].as_str().filter(|id| link::possession_id_ok(id)) {
        out["npc"] = json!(npc);
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
/// How a room draws a visitor (8.6), checked: `look` "theirs" or "mine", `eyes` (scene units, 0 to 1000) or null,
/// `problem` (at most 200 characters, no control characters) or null.
fn body_from(m: &Value) -> Value {
    let eyes = m.get("eyes").and_then(Value::as_f64).filter(|x| x.is_finite() && *x > 0.0).map(|x| x.min(1000.0));
    let problem = m.get("problem").and_then(Value::as_str).map(|s| s.chars().filter(|c| !c.is_control()).take(200).collect::<String>());
    json!({ "look": if m.get("look").and_then(Value::as_str) == Some("theirs") { "theirs" } else { "mine" }, "eyes": eyes, "problem": problem })
}

/// The most possessions an office says it has (8.11).
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
    // What the visitor rides (8.11): one of its possessions; the host decides.
    let riding = m.get("riding").and_then(Value::as_str).filter(|r| link::possession_id_ok(r));
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
        // one of the room's own figures: its id kept (never also the owner's), a bad id dropped (then it is nobody's)
        assert_eq!(said_from(&json!({ "key": "k4", "name": "Reception", "npc": "receptionist", "owner": true, "text": "Hello!" })),
                   Some(json!({ "key": "k4", "name": "Reception", "npc": "receptionist", "text": "Hello!" })));
        assert_eq!(said_from(&json!({ "key": "k4", "npc": "../x", "text": "hi" })), Some(json!({ "key": "k4", "name": "", "text": "hi" })));
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
        assert_eq!(clamp_input(&json!({ "riding": "my-dragon.2" }))["riding"], json!("my-dragon.2"));
        for bad in [json!("a b"), json!("visit:horse"), json!(5), json!("x".repeat(41))] {
            assert_eq!(clamp_input(&json!({ "riding": bad }))["riding"], Value::Null);
        }
    }

    #[test]
    fn bodies_are_checked() {
        assert_eq!(body_from(&json!({ "look": "theirs", "eyes": 1.5, "problem": null })), json!({ "look": "theirs", "eyes": 1.5, "problem": null }));
        assert_eq!(body_from(&json!({ "look": "x", "eyes": -2, "problem": "a\u{7}b".repeat(300) }))["look"], json!("mine"));
        assert_eq!(body_from(&json!({ "eyes": "high" }))["eyes"], Value::Null);
        assert_eq!(body_from(&json!({ "problem": "x".repeat(300) }))["problem"].as_str().unwrap().len(), 200);
    }

    #[test]
    fn possessions_are_checked() {
        let l = possessions_from(Some(&json!([{ "id": "dragon", "name": "Smaug\u{7}", "mount": true, "fly": true, "speed": 9, "lift": -1, "extra": 1 }, { "id": "cat" }]))).unwrap();
        assert_eq!(l, vec![json!({ "id": "dragon", "name": "Smaug", "mount": true, "fly": true, "speed": 5.0, "lift": 0.0 }),
            json!({ "id": "cat", "name": "cat", "mount": false, "fly": false, "speed": 1.0, "lift": 0.0 })]);
        assert!(possessions_from(Some(&json!([{ "id": "a" }, { "id": "a" }]))).is_none());   // twice the same
        assert!(possessions_from(Some(&json!([{ "id": "my:horse" }]))).is_none());   // not an id
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
