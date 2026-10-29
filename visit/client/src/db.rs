//! visit-client's database (../SPEC.md 8.12): the workroom's Postgres, inside visit (pg.rs). It keeps the chat its user has had
//! (their own lines too, and which they have not seen yet), the pictures, voice messages and links shared in it,
//! whispers left for someone away, and whom its room keeps out. Its schema is made by
//! visit at every start (pg.rs, before the run opens it): a run checks the database is at the version it needs, and says how to
//! bring it there if not. A task of its own talks to it; the core asks it (DbCmd), and hears back (Ev).
use std::{collections::BTreeMap, time::Duration};

use anyhow::{bail, Context, Result};
use bytes::Bytes;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_postgres::{Client, NoTls};
use tracing::{info, warn};

use crate::{core::Ev, state::Ban};

/// The schema's migrations, in order: (version, name, SQL). Each runs once, in a transaction of its own, recorded
/// in `visit_migrations`.
pub const MIGRATIONS: &[(i32, &str, &str)] = &[(1, "chat", include_str!("../migrations/0001_chat.sql")), (2, "mail", include_str!("../migrations/0002_mail.sql"))];

/// The schema this visit-client needs: its newest migration's version.
pub fn latest() -> i32 {
    MIGRATIONS.last().map_or(0, |m| m.0)
}

/// The most lines a page that comes back is given (the rest are its history, asked for); and of those its user has
/// not seen, the most it is shown (the rest are counted).
pub const CHAT_KEPT: usize = 100;
pub const UNSEEN_KEPT: usize = 100;
/// How long a whisper left for someone away is kept, at most (ms).
pub const HELD_FOR: i64 = 30 * 24 * 3600 * 1000;

/// A whisper left for someone not in the lobby (8.9): to whom (their key, and name), what, and when.
#[derive(Clone, Debug, PartialEq)]
pub struct Held {
    pub id: String,
    pub key: String,
    pub name: String,
    pub text: String,
    pub at: i64,
}

impl Held {
    pub fn json(&self) -> Value {
        json!({ "id": self.id, "key": self.key, "name": self.name, "text": self.text, "at": self.at })
    }
}

/// A connection to the database at `url` (postgres://user:password@host:port/database: beside this visit-client,
/// on this machine or its own network, so no TLS), driven by a task of its own.
pub async fn connect(url: &str) -> Result<Client> {
    let (client, conn) = tokio_postgres::connect(url, NoTls).await.with_context(|| format!("cannot reach the database at {}", redact(url)))?;
    tokio::spawn(async move {
        if let Err(e) = conn.await {
            if !auth::stopping() {
                warn!("the database connection ended: {e}");
            }
        }
    });
    Ok(client)
}

/// A database URL without its password, to say where it is.
pub fn redact(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else { return "(not a postgres:// URL)".into() };
    match rest.split_once('@') {
        Some((who, at)) => format!("{scheme}://{}@{at}", who.split(':').next().unwrap_or("")),
        None => url.to_string(),
    }
}

/// The schema's version: the newest migration applied (0: none, or no Visit tables at all).
pub async fn version(c: &Client) -> Result<i32> {
    if !c.query_one("SELECT to_regclass('visit_migrations') IS NOT NULL", &[]).await?.get::<_, bool>(0) {
        return Ok(0);
    }
    Ok(c.query_one("SELECT COALESCE(MAX(version), 0) FROM visit_migrations", &[]).await?.get::<_, i32>(0))
}

/// Brings the database to the schema this visit needs (pg.rs, at every start), each migration in a
/// transaction of its own, one run at a time (an advisory lock); or, `status`, only says where it is. Refuses a
/// database newer than it knows. What it did, a line each.
pub async fn migrate(url: &str, status: bool) -> Result<Vec<String>> {
    let mut c = connect(url).await?;
    c.query("SELECT pg_advisory_lock(7401)", &[]).await?;
    let at = version(&c).await?;
    if at > latest() {
        bail!("the database is at version {at}, newer than this visit-client knows ({}): use a newer visit-client", latest());
    }
    let pending: Vec<_> = MIGRATIONS.iter().filter(|m| m.0 > at).collect();
    let mut out = vec![format!("{}: at version {at}; this visit-client needs {}", redact(url), latest())];
    if status {
        out.extend(pending.iter().map(|(v, name, _)| format!("pending: {v} {name}")));
        if pending.is_empty() {
            out.push("up to date".into());
        }
        return Ok(out);
    }
    c.batch_execute("CREATE TABLE IF NOT EXISTS visit_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())").await?;
    for (v, name, sql) in pending {
        let t = c.transaction().await?;
        t.batch_execute(sql).await.with_context(|| format!("migration {v} ({name})"))?;
        t.execute("INSERT INTO visit_migrations (version, name) VALUES ($1, $2)", &[v, name]).await?;
        t.commit().await?;
        out.push(format!("applied: {v} {name}"));
    }
    if out.len() == 1 {
        out.push("up to date".into());
    }
    Ok(out)
}

/// What a run starts with: whom its room keeps out, the last lines its user had, the newest of those they have not
/// seen and how many there are in each conversation, and the whispers left for someone away.
pub struct Loaded {
    pub bans: Vec<Ban>,
    pub chat: Vec<Value>,
    pub unseen: Vec<Value>,
    pub unseen_by: BTreeMap<String, u64>,
    pub held: Vec<Held>,
}

/// The database for a run: reached (it may still be starting: tried for 30 s), at the schema this visit-client
/// needs (else what to run), and what the run starts with. Bans from an older state file come in once.
pub async fn open(url: &str, old_bans: &[Ban]) -> Result<(Client, Loaded)> {
    let mut tries = 0;
    let c = loop {
        match connect(url).await {
            Ok(c) => break c,
            Err(e) if tries >= 30 => return Err(e),
            Err(_) => {
                tries += 1;
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    };
    let at = version(&c).await?;
    if at < latest() {
        bail!("the database {} is at version {at}; this visit-client needs {}: start visit again (it brings it up to date at every start)",
              redact(url), latest());
    }
    if at > latest() {
        bail!("the database {} is at version {at}, newer than this visit-client knows ({}): use a newer visit-client", redact(url), latest());
    }
    for b in old_bans {
        c.execute("INSERT INTO bans (key, name, voice, chat, at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (key) DO NOTHING",
                  &[&b.key, &b.name, &b.voice, &b.chat, &now()]).await?;
    }
    let bans = c.query("SELECT key, name, voice, chat FROM bans ORDER BY at", &[]).await?.iter()
        .map(|r| Ban { key: r.get(0), name: r.get(1), voice: r.get(2), chat: r.get(3) }).collect();
    let mut chat: Vec<Value> = c.query("SELECT line FROM messages ORDER BY at DESC, id DESC LIMIT $1", &[&(CHAT_KEPT as i64)]).await?.iter().map(|r| r.get(0)).collect();
    chat.reverse();
    let mut unseen: Vec<Value> = c.query("SELECT line FROM messages WHERE unseen ORDER BY at DESC, id DESC LIMIT $1", &[&(UNSEEN_KEPT as i64)]).await?.iter().map(|r| r.get(0)).collect();
    unseen.reverse();
    let unseen_by = c.query("SELECT conversation, count(*) FROM messages WHERE unseen GROUP BY conversation", &[]).await?.iter()
        .map(|r| (r.get::<_, String>(0), r.get::<_, i64>(1) as u64)).collect();
    c.execute("DELETE FROM held WHERE at < $1", &[&(now() - HELD_FOR)]).await?;
    let held = c.query("SELECT id, to_key, to_name, text, at FROM held ORDER BY at, id", &[]).await?.iter()
        .map(|r| Held { id: r.get(0), key: r.get(1), name: r.get(2), text: r.get(3), at: r.get(4) }).collect();
    info!(url = %redact(url), version = at, "the database");
    Ok((c, Loaded { bans, chat, unseen, unseen_by, held }))
}

/// Milliseconds since 1970.
pub fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// What the core asks of the database.
pub enum DbCmd {
    /// A line of chat this office's user had, or said, as their page has it (with `at`, `conversation`); and whether
    /// it is one they have not seen yet.
    Line { line: Value, unseen: bool },
    /// This office's user has seen the lines of a conversation (none: of every one).
    Seen { conversation: Option<String> },
    /// A whisper left for someone away; and one passed on, or taken back.
    Hold(Held),
    Unhold(String),
    /// Someone kept out of this office's room's voice or chat, or no longer (neither).
    Ban(Ban),
    /// A picture, checked, by its id.
    PutMedia { id: String, mime: String, bytes: Bytes },
    /// A picture, for the page or for a link that asked: Ev::DbMedia.
    GetMedia { id: String, to: MediaTo },
    /// Whether this office has a picture a line over a link named: Ev::DbHas.
    HasMedia { id: String, visit: String },
    /// Lines before a moment, newest last (`req`: the page's, given back).
    History { req: Value, before: i64, limit: i64 },
    /// The pictures, the voice messages or the links shared in a conversation (`kind`: media, voice, links), newest
    /// first.
    Shared { req: Value, conversation: String, kind: &'static str, before: i64, limit: i64 },
}

/// Who asked for a picture: the page, or the other side of a visit (its id).
#[derive(Clone, Debug, PartialEq)]
pub enum MediaTo {
    Page,
    Link(String),
}

/// The database's task: each command in turn (in the order asked: a picture put is there for the next get). A
/// connection lost is made again (every second, until it is), and the command tried again; one that fails
/// otherwise is said (to the page, for what it asked).
pub async fn run(url: String, mut client: Client, mut rx: mpsc::UnboundedReceiver<DbCmd>, core: mpsc::UnboundedSender<Ev>) {
    while let Some(cmd) = rx.recv().await {
        loop {
            match handle(&mut client, &cmd, &core).await {
                Ok(()) => break,
                Err(e) if client.is_closed() => {
                    warn!("the database: {e:#}; connecting again");
                    loop {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        if let Ok(c) = connect(&url).await {
                            client = c;
                            break;
                        }
                    }
                }
                Err(e) => {
                    warn!("the database: {e:#}");
                    if let DbCmd::History { req, .. } | DbCmd::Shared { req, .. } = &cmd {
                        let _ = core.send(Ev::DbReply(json!({ "type": "error", "code": "database", "message": format!("{e:#}"), "ref": req })));
                    }
                    break;
                }
            }
        }
    }
}

async fn handle(c: &mut Client, cmd: &DbCmd, core: &mpsc::UnboundedSender<Ev>) -> Result<()> {
    match cmd {
        DbCmd::Line { line, unseen } => {
            let s = |k: &str| line.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            let scope = line.get("scope").and_then(Value::as_str).unwrap_or("say").to_string();
            let (at, mine, key) = (line.get("at").and_then(Value::as_i64).unwrap_or_else(now), line.get("mine") == Some(&json!(true)), line.get("key").and_then(Value::as_str).map(str::to_string));
            let t = c.transaction().await?;
            let id: i64 = t.query_one("INSERT INTO messages (at, conversation, scope, mine, sender_key, sender_name, text, line, unseen) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
                &[&at, &s("conversation"), &scope, &mine, &key, &s("name"), &s("text"), line, unseen]).await?.get(0);
            for (i, m) in line.get("media").and_then(Value::as_array).into_iter().flatten().enumerate() {
                let (mid, mime, size) = (m["id"].as_str().unwrap_or(""), m["mime"].as_str().unwrap_or(""), m["size"].as_i64().unwrap_or(0) as i32);
                t.execute("INSERT INTO message_media (message_id, position, media_id, mime, size) VALUES ($1, $2, $3, $4, $5)", &[&id, &(i as i16), &mid, &mime, &size]).await?;
            }
            for l in line.get("links").and_then(Value::as_array).into_iter().flatten() {
                let ls = |k: &str| l.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                let image = l.get("image").and_then(|i| i.get("id")).and_then(Value::as_str).map(str::to_string);
                t.execute("INSERT INTO links (message_id, url, title, description, site, image_id) VALUES ($1, $2, $3, $4, $5, $6)",
                          &[&id, &ls("url"), &ls("title"), &ls("description"), &ls("site"), &image]).await?;
            }
            t.commit().await?;
        }
        DbCmd::Seen { conversation } => {
            c.execute("UPDATE messages SET unseen = false WHERE unseen AND ($1::text IS NULL OR conversation = $1)", &[conversation]).await?;
        }
        DbCmd::Hold(h) => {
            c.execute("INSERT INTO held (id, to_key, to_name, text, at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING", &[&h.id, &h.key, &h.name, &h.text, &h.at]).await?;
        }
        DbCmd::Unhold(id) => {
            c.execute("DELETE FROM held WHERE id = $1", &[id]).await?;
        }
        DbCmd::Ban(b) => {
            if b.voice || b.chat {
                c.execute("INSERT INTO bans (key, name, voice, chat, at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (key) DO UPDATE SET name = $2, voice = $3, chat = $4, at = $5",
                          &[&b.key, &b.name, &b.voice, &b.chat, &now()]).await?;
            } else {
                c.execute("DELETE FROM bans WHERE key = $1", &[&b.key]).await?;
            }
        }
        DbCmd::PutMedia { id, mime, bytes } => {
            c.execute("INSERT INTO media (id, mime, size, at, bytes) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING",
                      &[id, mime, &(bytes.len() as i32), &now(), &&bytes[..]]).await?;
        }
        DbCmd::GetMedia { id, to } => {
            let found = c.query_opt("SELECT mime, bytes FROM media WHERE id = $1", &[id]).await?
                .map(|r| (r.get::<_, String>(0), Bytes::from(r.get::<_, Vec<u8>>(1))));
            let _ = core.send(Ev::DbMedia { id: id.clone(), to: to.clone(), found });
        }
        DbCmd::HasMedia { id, visit } => {
            let has = c.query_opt("SELECT 1 FROM media WHERE id = $1", &[id]).await?.is_some();
            let _ = core.send(Ev::DbHas { id: id.clone(), visit: visit.clone(), has });
        }
        DbCmd::History { req, before, limit } => {
            let mut lines: Vec<Value> = c.query("SELECT line FROM messages WHERE at < $1 ORDER BY at DESC, id DESC LIMIT $2", &[before, &(limit + 1)]).await?
                .iter().map(|r| r.get(0)).collect();
            let more = lines.len() as i64 > *limit;
            lines.truncate(*limit as usize);
            lines.reverse();
            let _ = core.send(Ev::DbReply(json!({ "type": "history", "req": req, "lines": lines, "more": more })));
        }
        DbCmd::Shared { req, conversation, kind, before, limit } => {
            let links = *kind == "links";
            let rows = if links {
                c.query("SELECT m.at, m.sender_key, m.sender_name, m.mine, l.url, l.title, l.description, l.site, l.image_id FROM links l JOIN messages m ON m.id = l.message_id \
                         WHERE m.conversation = $1 AND m.at < $2 ORDER BY m.at DESC, l.id DESC LIMIT $3", &[conversation, before, &(limit + 1)]).await?
            } else {
                let audio = *kind == "voice";
                c.query("SELECT m.at, m.sender_key, m.sender_name, m.mine, mm.media_id, mm.mime, mm.size FROM message_media mm JOIN messages m ON m.id = mm.message_id \
                         WHERE m.conversation = $1 AND m.at < $2 AND (mm.mime LIKE 'audio/%') = $4 ORDER BY m.at DESC, m.id DESC, mm.position LIMIT $3",
                        &[conversation, before, &(limit + 1), &audio]).await?
            };
            let more = rows.len() as i64 > *limit;
            let items: Vec<Value> = rows.iter().take(*limit as usize).map(|r| {
                let mut item = json!({ "at": r.get::<_, i64>(0), "key": r.get::<_, Option<String>>(1), "name": r.get::<_, String>(2), "mine": r.get::<_, bool>(3) });
                if links {
                    item["url"] = json!(r.get::<_, String>(4));
                    item["title"] = json!(r.get::<_, String>(5));
                    item["description"] = json!(r.get::<_, String>(6));
                    item["site"] = json!(r.get::<_, String>(7));
                    item["image"] = r.get::<_, Option<String>>(8).map_or(Value::Null, |id| json!({ "id": id }));
                } else {
                    item["id"] = json!(r.get::<_, String>(4));
                    item["mime"] = json!(r.get::<_, String>(5));
                    item["size"] = json!(r.get::<_, i32>(6));
                }
                item
            }).collect();
            let _ = core.send(Ev::DbReply(json!({ "type": "shared", "req": req, "conversation": conversation, "kind": kind, "items": items, "more": more })));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_go_up_one_by_one() {
        assert!(MIGRATIONS.iter().enumerate().all(|(i, m)| m.0 == i as i32 + 1 && !m.1.is_empty() && !m.2.trim().is_empty()));
        assert_eq!(latest(), MIGRATIONS.len() as i32);
    }

    #[test]
    fn a_url_said_without_its_password() {
        assert_eq!(redact("postgres://visit:s3cret@127.0.0.1:7432/visit"), "postgres://visit@127.0.0.1:7432/visit");
        assert_eq!(redact("postgres://127.0.0.1/visit"), "postgres://127.0.0.1/visit");
        assert_eq!(redact("nonsense"), "(not a postgres:// URL)");
    }
}
