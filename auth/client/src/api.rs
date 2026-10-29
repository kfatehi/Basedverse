//! auth-client's API (../SPEC.md 3): HTTP and JSON on 127.0.0.1 (or its container's network: --listen), for the
//! workroom's server only (its service token on every call but /health); the browser never talks to it. Sessions
//! and keys are checked from memory: a cache of
//! the live ones, read from the database at the start, again whenever the terminal's commands change them (NOTIFY
//! auth_changed), and every minute besides. A session's last use is written at most once a minute.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use serde_json::{json, Value};
use subtle::ConstantTimeEq;
use tokio::sync::Semaphore;
use tokio_postgres::{AsyncMessage, Client, NoTls};
use tracing::{info, warn};

use crate::{db, secret, VERSION};

/// A session's or a key's last use, written at most this often.
const SAVE_EVERY: Duration = Duration::from_secs(60);
/// Guesses: after this many wrong in WINDOW (for a name, or from an address), each try waits twice as long as the
/// last, from 1 s, at most MAX_WAIT.
const FREE_TRIES: i64 = 5;
const WINDOW: &str = "15 minutes";
const MAX_WAIT: f64 = 900.0;
/// Passwords checked at once (each hash takes 19 MiB): more wait their turn.
const HASHING: usize = 4;
/// Sign-ins kept for the audit.
const ATTEMPTS_KEPT: &str = "90 days";

/// What a run is given.
pub struct Config {
    pub database: String,
    /// Where it answers: 127.0.0.1, or its container's own network (0.0.0.0 there).
    pub listen: std::net::IpAddr,
    pub port: u16,
    /// The service token the workroom's server sends.
    pub token: String,
    /// A session ends after this long unused, and this long in all.
    pub idle: Duration,
    pub max_age: Duration,
    /// visit-client's port and token file, for /v1/visit; and whether to make sure its port answers.
    pub visit: Option<(u16, PathBuf)>,
    pub visit_probe: bool,
}

struct Live {
    user: String,
    expires: SystemTime,
    seen: SystemTime,
    saved: SystemTime,
}

struct Key {
    label: String,
    saved: Option<SystemTime>,
}

struct App {
    cfg: Config,
    db: Db,
    sessions: Mutex<HashMap<Vec<u8>, Live>>,
    keys: Mutex<HashMap<Vec<u8>, Key>>,
    /// A hash of nothing anyone knows: an unknown name is checked against it, so it takes as long as a known one.
    dummy: String,
    hashing: Semaphore,
}

/// The database, reached again when its connection ends.
struct Db {
    url: String,
    client: tokio::sync::Mutex<Option<Arc<Client>>>,
}

impl Db {
    async fn get(&self) -> Result<Arc<Client>> {
        let mut c = self.client.lock().await;
        if let Some(x) = c.as_ref().filter(|x| !x.is_closed()) {
            return Ok(x.clone());
        }
        let x = Arc::new(db::connect(&self.url).await?);
        *c = Some(x.clone());
        Ok(x)
    }
}

enum Login {
    In { session: String, user: String, expires: SystemTime },
    Wrong,
    Wait(u64),
}

type Reply = (StatusCode, Json<Value>);

fn reply(code: StatusCode, v: Value) -> Reply {
    (code, Json(v))
}

fn unix(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// How long a sign-in must still wait, after `wrong` wrong ones in the window, the last `since_last` seconds ago.
pub fn backoff(wrong: i64, since_last: f64) -> u64 {
    if wrong < FREE_TRIES {
        return 0;
    }
    let need = 2f64.powi((wrong - FREE_TRIES).min(20) as i32).min(MAX_WAIT);
    if since_last >= need { 0 } else { (need - since_last).ceil() as u64 }
}

impl App {
    /// The service token, as the workroom's server sends it (`Authorization: Bearer`), compared in constant time.
    fn trusted(&self, h: &HeaderMap) -> bool {
        h.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "))
            .is_some_and(|t| bool::from(t.as_bytes().ct_eq(self.cfg.token.as_bytes())))
    }

    /// The live sessions and keys, read again (a session's use as this run has it, if newer).
    async fn reload(&self) -> Result<()> {
        let db = self.db.get().await?;
        let rows = db.query("SELECT s.id_hash, u.name, s.expires_at, s.last_seen_at FROM auth.sessions s JOIN auth.users u ON u.id = s.user_id
                             WHERE s.expires_at > now()", &[]).await?;
        let keys = db.query("SELECT key_hash, label, last_used_at FROM auth.api_keys WHERE revoked_at IS NULL", &[]).await?;
        {
            let mut m = self.sessions.lock().unwrap();
            let old = std::mem::take(&mut *m);
            for r in rows {
                let (h, seen): (Vec<u8>, SystemTime) = (r.get(0), r.get(3));
                let was = old.get(&h);
                m.insert(h.clone(), Live { user: r.get(1), expires: r.get(2), seen: was.map_or(seen, |w| w.seen.max(seen)), saved: was.map_or(seen, |w| w.saved) });
            }
        }
        let mut m = self.keys.lock().unwrap();
        let old = std::mem::take(&mut *m);
        for r in keys {
            let h: Vec<u8> = r.get(0);
            let saved = old.get(&h).map_or(r.get(2), |w| w.saved);
            m.insert(h, Key { label: r.get(1), saved });
        }
        Ok(())
    }

    /// How long a sign-in for `name` (from `address`) must still wait: the longer of the two.
    async fn wait(&self, db: &Client, name: &str, address: Option<&str>) -> Result<u64> {
        let mut worst = 0;
        for (by, v) in [("lower(user_name) = lower($1)", Some(name)), ("client_address = $1", address)] {
            let Some(v) = v else { continue };
            let r = db.query_one(&format!(
                "SELECT count(*), EXTRACT(EPOCH FROM now() - max(at))::float8 FROM auth.login_attempts
                 WHERE {by} AND NOT ok AND NOT waited AND at > now() - interval '{WINDOW}'
                   AND at > COALESCE((SELECT max(at) FROM auth.login_attempts WHERE {by} AND ok), '-infinity')"), &[&v]).await?;
            worst = worst.max(backoff(r.get(0), r.get::<_, Option<f64>>(1).unwrap_or(f64::MAX)));
        }
        Ok(worst)
    }

    async fn login(self: &Arc<Self>, name: &str, password: &str, address: Option<&str>, agent: Option<&str>) -> Result<Login> {
        let db = self.db.get().await?;
        let note = |ok: bool, waited: bool| {
            let (db, name, address) = (db.clone(), name.to_string(), address.map(str::to_string));
            async move {
                db.execute("INSERT INTO auth.login_attempts (user_name, client_address, ok, waited) VALUES ($1, $2, $3, $4)", &[&name, &address, &ok, &waited]).await
            }
        };
        let wait = self.wait(&db, name, address).await?;
        if wait > 0 {
            note(false, true).await?;
            return Ok(Login::Wait(wait));
        }
        let row = db.query_opt("SELECT id, name, password_hash FROM auth.users WHERE lower(name) = lower($1)", &[&name]).await?;
        let hash = row.as_ref().map_or_else(|| self.dummy.clone(), |r| r.get(2));
        let ok = {
            let _turn = self.hashing.acquire().await?;
            let password = password.to_string();
            tokio::task::spawn_blocking(move || secret::password_matches(&password, &hash)).await?
        } && row.is_some();
        note(ok, false).await?;
        let Some(r) = row.filter(|_| ok) else { return Ok(Login::Wrong) };
        let (user_id, user): (i64, String) = (r.get(0), r.get(1));
        let (session, now) = (secret::session_id(), SystemTime::now());
        let (h, expires) = (secret::digest(&session), now + self.cfg.max_age);
        db.execute("INSERT INTO auth.sessions (id_hash, user_id, created_at, last_seen_at, expires_at, client_address, user_agent) VALUES ($1, $2, $3, $3, $4, $5, $6)",
                   &[&h, &user_id, &now, &expires, &address, &agent]).await?;
        self.sessions.lock().unwrap().insert(h, Live { user: user.clone(), expires, seen: now, saved: now });
        info!(%user, address = address.unwrap_or("-"), "signed in");
        Ok(Login::In { session, user, expires })
    }

    /// A session's user, if it is live: its idle time starts again (written now and then). One that has ended is
    /// forgotten.
    fn touch(self: &Arc<Self>, session: &str) -> Option<String> {
        if session.len() > 128 {
            return None;
        }
        let (h, now) = (secret::digest(session), SystemTime::now());
        let mut m = self.sessions.lock().unwrap();
        let live = m.get_mut(&h)?;
        if now >= live.expires || now.duration_since(live.seen).unwrap_or_default() >= self.cfg.idle {
            m.remove(&h);
            let app = self.clone();
            tokio::spawn(async move { app.forget(h).await });
            return None;
        }
        live.seen = now;
        if now.duration_since(live.saved).unwrap_or_default() >= SAVE_EVERY {
            live.saved = now;
            let app = self.clone();
            tokio::spawn(async move {
                if let Ok(db) = app.db.get().await {
                    let _ = db.execute("UPDATE auth.sessions SET last_seen_at = $2 WHERE id_hash = $1", &[&h, &now]).await;
                }
            });
        }
        Some(live.user.clone())
    }

    /// An API key's label, if it is live (its last use written now and then).
    fn key(self: &Arc<Self>, key: &str) -> Option<String> {
        if key.len() > 128 {
            return None;
        }
        let (h, now) = (secret::digest(key), SystemTime::now());
        let mut m = self.keys.lock().unwrap();
        let k = m.get_mut(&h)?;
        if k.saved.is_none_or(|t| now.duration_since(t).unwrap_or_default() >= SAVE_EVERY) {
            k.saved = Some(now);
            let app = self.clone();
            tokio::spawn(async move {
                if let Ok(db) = app.db.get().await {
                    let _ = db.execute("UPDATE auth.api_keys SET last_used_at = $2 WHERE key_hash = $1", &[&h, &now]).await;
                }
            });
        }
        Some(k.label.clone())
    }

    async fn forget(&self, h: Vec<u8>) {
        self.sessions.lock().unwrap().remove(&h);
        if let Ok(db) = self.db.get().await {
            let _ = db.execute("DELETE FROM auth.sessions WHERE id_hash = $1", &[&h]).await;
        }
    }

    /// Sessions over, out of the database (a session used in this run may be a minute newer than it says); old
    /// sign-ins too.
    async fn sweep(&self) -> Result<()> {
        let db = self.db.get().await?;
        let idle = self.cfg.idle.as_secs_f64() + 2.0 * SAVE_EVERY.as_secs_f64();
        db.execute("DELETE FROM auth.sessions WHERE expires_at <= now() OR last_seen_at < now() - make_interval(secs => $1)", &[&idle]).await?;
        db.execute(&format!("DELETE FROM auth.login_attempts WHERE at < now() - interval '{ATTEMPTS_KEPT}'"), &[]).await?;
        Ok(())
    }
}

fn parse(body: &Bytes) -> Option<Value> {
    serde_json::from_slice::<Value>(body).ok().filter(Value::is_object)
}

fn bad() -> Reply {
    reply(StatusCode::BAD_REQUEST, json!({ "error": "bad_request" }))
}

fn untrusted() -> Reply {
    reply(StatusCode::UNAUTHORIZED, json!({ "error": "service_token" }))
}

async fn health() -> Reply {
    reply(StatusCode::OK, json!({ "ok": true, "version": VERSION }))
}

/// `POST /v1/login` {user, password, client: {address, agent}}.
async fn login(State(app): State<Arc<App>>, h: HeaderMap, body: Bytes) -> Reply {
    if !app.trusted(&h) {
        return untrusted();
    }
    let Some(b) = parse(&body) else { return bad() };
    let (Some(user), Some(password)) = (b["user"].as_str(), b["password"].as_str()) else { return bad() };
    let address = b["client"]["address"].as_str().map(|s| clip(s, 100)).filter(|s| !s.is_empty());
    let agent = b["client"]["agent"].as_str().map(|s| clip(s, 300));
    match app.login(&clip(user.trim(), 64), password, address.as_deref(), agent.as_deref()).await {
        Ok(Login::In { session, user, expires }) => reply(StatusCode::OK, json!({ "session": session, "user": user, "expires": unix(expires) })),
        Ok(Login::Wrong) => reply(StatusCode::UNAUTHORIZED, json!({ "error": "wrong_login" })),
        Ok(Login::Wait(s)) => reply(StatusCode::TOO_MANY_REQUESTS, json!({ "error": "wait", "retry_after": s })),
        Err(e) => {
            warn!("a sign-in: {e:#}");
            reply(StatusCode::SERVICE_UNAVAILABLE, json!({ "error": "unavailable" }))
        }
    }
}

/// `POST /v1/check` {session} or {key}.
async fn check(State(app): State<Arc<App>>, h: HeaderMap, body: Bytes) -> Reply {
    if !app.trusted(&h) {
        return untrusted();
    }
    let Some(b) = parse(&body) else { return bad() };
    match (b["session"].as_str(), b["key"].as_str()) {
        (Some(s), None) => match app.touch(s) {
            Some(user) => reply(StatusCode::OK, json!({ "user": user })),
            None => reply(StatusCode::UNAUTHORIZED, json!({ "error": "no_session" })),
        },
        (None, Some(k)) => match app.key(k) {
            Some(label) => reply(StatusCode::OK, json!({ "key": label })),
            None => reply(StatusCode::UNAUTHORIZED, json!({ "error": "no_key" })),
        },
        _ => bad(),
    }
}

/// `POST /v1/logout` {session}.
async fn logout(State(app): State<Arc<App>>, h: HeaderMap, body: Bytes) -> Reply {
    if !app.trusted(&h) {
        return untrusted();
    }
    let Some(s) = parse(&body).and_then(|b| b["session"].as_str().map(str::to_string)) else { return bad() };
    if s.len() <= 128 {
        app.forget(secret::digest(&s)).await;
    }
    reply(StatusCode::OK, json!({}))
}

/// `POST /v1/visit` {session}: visit-client's port and token, read fresh from its token file, for a session that
/// is live; 404 when no visit-client runs.
async fn visit(State(app): State<Arc<App>>, h: HeaderMap, body: Bytes) -> Reply {
    if !app.trusted(&h) {
        return untrusted();
    }
    let Some(s) = parse(&body).and_then(|b| b["session"].as_str().map(str::to_string)) else { return bad() };
    if app.touch(&s).is_none() {
        return reply(StatusCode::UNAUTHORIZED, json!({ "error": "no_session" }));
    }
    let none = || reply(StatusCode::NOT_FOUND, json!({ "error": "no_visit_client" }));
    let Some((port, file)) = &app.cfg.visit else { return none() };
    let token = match tokio::fs::read_to_string(file).await {
        Ok(t) if !t.trim().is_empty() => t.trim().to_string(),
        _ => return none(),
    };
    if app.cfg.visit_probe {
        let up = tokio::time::timeout(Duration::from_millis(500), tokio::net::TcpStream::connect(("127.0.0.1", *port))).await;
        if !matches!(up, Ok(Ok(_))) {
            return none();
        }
    }
    reply(StatusCode::OK, json!({ "port": port, "token": token }))
}

/// Hears what the terminal's commands change (NOTIFY auth_changed), and reads the sessions and keys again; every
/// minute too, and then sweeps what is over. Listens again if its connection ends.
async fn listen(app: Arc<App>) {
    let mut ticks = 0u32;
    loop {
        if let Err(e) = listening(&app, &mut ticks).await {
            warn!("listening for changes: {e:#}");
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

async fn listening(app: &Arc<App>, ticks: &mut u32) -> Result<()> {
    let (client, mut conn) = tokio_postgres::connect(&app.cfg.database, NoTls).await?;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let driver = tokio::spawn(async move {
        let mut messages = futures_util::stream::poll_fn(move |cx| conn.poll_message(cx));
        while let Some(m) = messages.next().await {
            match m {
                Ok(AsyncMessage::Notification(_)) => { let _ = tx.send(()); }
                Ok(_) => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    });
    client.batch_execute(&format!("LISTEN {}", db::CHANGED)).await?;
    app.reload().await?;   // what changed while it was not listening
    let mut minute = tokio::time::interval(Duration::from_secs(60));
    minute.tick().await;
    let ended = loop {
        tokio::select! {
            m = rx.recv() => {
                if m.is_none() { break "the connection ended" }
                while rx.try_recv().is_ok() {}
                app.reload().await?;
            }
            _ = minute.tick() => {
                app.reload().await?;
                *ticks += 1;
                if *ticks % 10 == 1 {
                    app.sweep().await?;
                }
            }
        }
    };
    driver.abort();
    anyhow::bail!(ended)
}

/// A run: the API on its address (127.0.0.1, or its container's network) until it is stopped.
pub async fn serve(cfg: Config, client: Client) -> Result<()> {
    let dummy = tokio::task::spawn_blocking(|| secret::hash_password(&secret::hex(&secret::random(16)))).await??;
    let db = Db { url: cfg.database.clone(), client: tokio::sync::Mutex::new(Some(Arc::new(client))) };
    let at = std::net::SocketAddr::new(cfg.listen, cfg.port);
    let app = Arc::new(App { cfg, db, sessions: Mutex::default(), keys: Mutex::default(), dummy, hashing: Semaphore::new(HASHING) });
    app.reload().await?;
    app.sweep().await?;
    tokio::spawn(listen(app.clone()));
    let router = Router::new()
        .route("/health", get(health))
        .route("/v1/login", post(login))
        .route("/v1/check", post(check))
        .route("/v1/logout", post(logout))
        .route("/v1/visit", post(visit))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(at).await.with_context(|| at.to_string())?;
    info!(version = VERSION, "listening on {at}");
    axum::serve(listener, router).with_graceful_shutdown(async { let _ = tokio::signal::ctrl_c().await; }).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guesses_wait_twice_as_long_each_time() {
        assert_eq!(backoff(4, 0.0), 0);
        assert_eq!(backoff(5, 0.0), 1);
        assert_eq!(backoff(5, 1.0), 0);
        assert_eq!(backoff(6, 0.5), 2);   // 2 s, 0.5 gone
        assert_eq!(backoff(8, 0.0), 8);
        assert_eq!(backoff(30, 0.0), 900);   // at most 15 minutes
        assert_eq!(backoff(30, 899.5), 1);
        assert_eq!(backoff(30, f64::MAX), 0);
    }
}
