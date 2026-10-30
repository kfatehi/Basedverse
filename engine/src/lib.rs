//! The engine (../SPEC.md 5; ../../V2.md 5), inside `visit`: the room's server page in the headless Chrome visit
//! carries, its key on every request to the room's origin and on nothing else, the shim (shim.js) in front of it,
//! kept alive (reloads with backoff, a memory ceiling), and `/health`. engine/driver/engine.py was this, in Python,
//! in a container of its own.
mod cdp;

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};
use tracing::{debug, error, info, warn};

use cdp::{Browser, CdpError};

pub use cdp::executable;

const SHIM: &str = include_str!("shim.js");
const READY: Duration = Duration::from_secs(60);
const STALL: Duration = Duration::from_secs(10);
const BACKOFF_MAX: u64 = 30;
const MEMORY_EVERY: Duration = Duration::from_secs(5);

/// What the engine asks the page once a second (SPEC 5.1, points 5 and 6): who is there (visit.js's visitors,
/// watchers and owner, the page's connection as window.visit), the shim's frame count, and whether `ready` came.
const PROBE: &str = r#"(() => { const v = window.visit, E = window.VISIT_ENGINE;
  const n = v && typeof v === "object" ? ((v.visitors || []).length + (v.watchers || []).length + (v.owner ? 1 : 0)) : 0;
  if (E) E.idle = n === 0;
  return JSON.stringify({ frames: E ? E.frames : null, people: n, ready: !!(v && typeof v === "object" && v.office !== undefined) }); })()"#;

/// The engine's settings (SPEC 5.2, as V2.md 2.2 has them): what visit gives it from its own.
pub struct Config {
    /// The room's server page.
    pub room_url: String,
    /// The Chrome inside visit, unpacked (deps/README.md: its executable at the top; on Linux, lib/ and fonts/).
    pub chrome: PathBuf,
    /// Its profile, made new at each start.
    pub profile: PathBuf,
    /// visit-client's page connection (ws://127.0.0.1:<port>/ws), and the host token.
    pub visit_url: String,
    pub token: String,
    /// The API key the room's server takes from the engine (made by visit at each start).
    pub key: String,
    /// `/health` (and, with `debug`, the test aid), on this address and port.
    pub listen: IpAddr,
    pub port: u16,
    pub tick_idle: u32,
    pub memory_max_mib: u64,
    pub window: (u32, u32),
    pub debug: bool,
    pub version: &'static str,
}

/// What `/health` says, and what the loop and the event handler share.
struct Shared {
    room: Mutex<(&'static str, u64)>,
    reloads: AtomicU64,
    browser: Mutex<Option<Arc<Browser>>>,
    session: Mutex<Option<String>>,
    crashed: AtomicBool,
    documents: Mutex<Vec<(String, i64)>>,
    key: String,
    version: &'static str,
}

impl Shared {
    fn set_room(&self, state: &'static str) {
        let mut r = self.room.lock().unwrap();
        if r.0 != state {
            *r = (state, now_ms());
        }
    }
    fn browser(&self) -> Option<Arc<Browser>> {
        self.browser.lock().unwrap().clone()
    }
    fn session(&self) -> Option<String> {
        self.session.lock().unwrap().clone()
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// The engine's port, taken (so a visit whose engine port is in use says so before it says it is ready); then what
/// runs the engine until `stop` turns true.
pub async fn start(cfg: Config, stop: watch::Receiver<bool>) -> Result<impl std::future::Future<Output = ()>> {
    let at = SocketAddr::new(cfg.listen, cfg.port);
    let listener = tokio::net::TcpListener::bind(at).await.with_context(|| format!("the engine's port: {at}"))?;
    let origin = origin(&cfg.room_url).with_context(|| format!("ENGINE_ROOM_URL {}: an http:// or https:// URL", cfg.room_url))?;
    Ok(async move {
        let shared = Arc::new(Shared {
            room: Mutex::new(("loading", now_ms())), reloads: AtomicU64::new(0), browser: Mutex::new(None), session: Mutex::new(None),
            crashed: AtomicBool::new(false), documents: Mutex::new(Vec::new()), key: cfg.key.clone(), version: cfg.version,
        });
        let mut routes = Router::new().route("/health", get(health));
        if cfg.debug {
            routes = routes.route("/debug/eval", post(debug_eval)).route("/debug/crash", post(debug_crash));
        }
        let app = routes.with_state(shared.clone());
        let mut s = stop.clone();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).with_graceful_shutdown(async move { let _ = s.wait_for(|v| *v).await; }).await;
        });
        info!(target: "engine", "{}; /health on {at}{}", cfg.room_url, if cfg.debug { "; ENGINE_DEBUG" } else { "" });
        Engine { cfg, origin, shared, no_sandbox: false, stop }.run().await;
    })
}

fn origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme != "http" && scheme != "https" {
        return None;
    }
    Some(format!("{scheme}://{}", rest.split('/').next()?))
}

/// The room's origin, if a browser would not take it as a secure context: http://, and not loopback.
fn insecure(origin: &str) -> Option<&str> {
    let host = origin.strip_prefix("http://")?;
    let host = host.rsplit_once(':').filter(|(h, p)| !h.is_empty() && p.chars().all(|c| c.is_ascii_digit())).map_or(host, |(h, _)| h);
    let loopback = host == "localhost" || host.ends_with(".localhost") || host == "[::1]" || host.starts_with("127.");
    (!loopback).then_some(origin)
}

struct Engine {
    cfg: Config,
    origin: String,
    shared: Arc<Shared>,
    no_sandbox: bool,
    stop: watch::Receiver<bool>,
}

impl Engine {
    fn stopped(&self) -> bool {
        *self.stop.borrow()
    }

    /// Waits `d`, or less if asked to stop: whether it was asked.
    async fn wait(&mut self, d: Duration) -> bool {
        tokio::time::timeout(d, self.stop.wait_for(|v| *v)).await.is_ok()
    }

    async fn run(mut self) {
        let mut backoff = 1u64;
        let mut memory_checked = Instant::now() - MEMORY_EVERY;
        while !self.stopped() {
            let alive = self.shared.browser().is_some_and(|b| b.alive().is_ok());
            if !alive {
                self.stop_browser().await;
                match self.start_browser().await {
                    Some(b) => *self.shared.browser.lock().unwrap() = Some(Arc::new(b)),
                    None => {
                        if self.wait(Duration::from_secs(5)).await {
                            break;
                        }
                        continue;
                    }
                }
            }
            let reloads = self.shared.reloads.load(Ordering::Relaxed);
            info!(target: "engine", "room: loading {}{}", self.cfg.room_url, if reloads > 0 { format!(" (again, {reloads})") } else { String::new() });
            if let Err(e) = self.load().await {
                let reason = match e {
                    CdpError::Timeout(_) => format!("could not load {}: no answer in {} s", self.cfg.room_url, READY.as_secs()),
                    CdpError::Gone => "the browser exited".to_string(),
                    CdpError::Failed(m) => m,
                };
                self.fail(&reason, backoff).await;
                backoff = (backoff * 2).min(BACKOFF_MAX);
                continue;
            }
            let loaded = Instant::now();
            let (mut last_frame_at, mut frames, mut hosting) = (loaded, None::<u64>, false);
            let mut reason = None;
            loop {
                if self.wait(Duration::from_secs(1)).await {
                    break;
                }
                let now = Instant::now();
                let Some(b) = self.shared.browser() else { break };
                if let Err(code) = b.alive() {
                    reason = Some(format!("the browser exited (code {})", code.map_or("?".into(), |c| c.to_string())));
                    break;
                }
                if self.shared.crashed.load(Ordering::Relaxed) {
                    reason = Some("the page crashed".into());
                    break;
                }
                if now - memory_checked > MEMORY_EVERY {
                    memory_checked = now;
                    let mib = memory_mib(b.pid);
                    debug!(target: "engine", "browser: {mib} MiB");
                    if mib > self.cfg.memory_max_mib {
                        warn!(target: "engine", "browser at {mib} MiB, past ENGINE_MEMORY_MAX {}: starting it again", self.cfg.memory_max_mib);
                        self.stop_browser().await;
                        self.shared.set_room("loading");
                        self.shared.reloads.fetch_add(1, Ordering::Relaxed);
                        break;
                    }
                }
                let p = self.probe(&b).await;
                if let Some(f) = p.as_ref().and_then(|p| p.get("frames")).and_then(Value::as_u64) {
                    if frames != Some(f) {
                        frames = Some(f);
                        last_frame_at = now;
                    }
                }
                if now - last_frame_at > STALL {
                    reason = Some(format!("no frame in {} s", STALL.as_secs()));
                    break;
                }
                if !hosting {
                    if p.as_ref().and_then(|p| p.get("ready")).and_then(Value::as_bool) == Some(true) {
                        hosting = true;
                        backoff = 1;
                        self.shared.set_room("hosting");
                        info!(target: "engine", "room: hosting");
                    } else if now - loaded > READY {
                        reason = Some(format!("`ready` never came in {} s", READY.as_secs()));
                        break;
                    }
                }
            }
            if let Some(r) = reason {
                self.fail(&r, backoff).await;
                backoff = (backoff * 2).min(BACKOFF_MAX);
            }
        }
        self.stop_browser().await;
        let _ = std::fs::remove_dir_all(&self.cfg.profile);
        info!(target: "engine", "stopped");
    }

    /// The browser, started (its own sandbox first; where the machine allows none, without, said once).
    async fn start_browser(&mut self) -> Option<Browser> {
        let exe = cdp::executable(&self.cfg.chrome);
        let (w, h) = self.cfg.window;
        let mut env = Vec::new();
        if cfg!(target_os = "linux") {
            env.push(("LD_LIBRARY_PATH".into(), self.cfg.chrome.join("lib").display().to_string()));
            env.push(("FONTCONFIG_FILE".into(), self.cfg.chrome.join("fonts/fonts.conf").display().to_string()));
        }
        loop {
            let _ = std::fs::remove_dir_all(&self.cfg.profile);
            let _ = std::fs::create_dir_all(&self.cfg.profile);
            let mut args: Vec<String> = ["--disable-gpu", "--enable-unsafe-swiftshader", "--no-first-run", "--no-default-browser-check",
                                         "--disable-dev-shm-usage",
                                         // its audio runs with no click (a room's own voices, visit/SPEC.md 8.7: encoded, never played here)
                                         "--autoplay-policy=no-user-gesture-required",
                                         // and nothing it plays reaches the machine's speakers (its audio still runs, for voiceAt)
                                         "--mute-audio"].map(String::from).to_vec();
            args.push(format!("--window-size={w},{h}"));
            // the room's page is a secure context wherever the room is served from (an http:// room by its name on a
            // container network, say): WebCodecs and AudioWorklet, which a room's own voices need (visit/SPEC.md 8.7),
            // exist only in one. Loopback is one already.
            if let Some(o) = insecure(&self.origin) {
                args.push(format!("--unsafely-treat-insecure-origin-as-secure={o}"));
            }
            if self.no_sandbox {
                args.push("--no-sandbox".into());
            }
            args.push("about:blank".into());
            let (tx, rx) = mpsc::unbounded_channel();
            let b = match Browser::start(&exe, &args, &env, &self.cfg.profile, tx).await {
                Ok(b) => b,
                Err(e) => {
                    error!(target: "engine", "cannot start {}: {e:#}", exe.display());
                    self.shared.set_room("failed");
                    return None;
                }
            };
            match b.call("Browser.getVersion", json!({}), None, Duration::from_secs(30)).await {
                Ok(v) => {
                    info!(target: "engine", "{} started (pid {}{})", v["product"].as_str().unwrap_or("Chrome"), b.pid,
                          if self.no_sandbox { ", no sandbox" } else { "" });
                    tokio::spawn(events(rx, self.shared.clone()));
                    return Some(b);
                }
                Err(_) => {
                    b.stop().await;
                    let tail: Vec<String> = b.stderr.lock().unwrap().iter().cloned().collect();
                    let said = tail.iter().find(|l| { let l = l.to_lowercase(); l.contains("sandbox") || l.contains("namespace") });
                    if !self.no_sandbox && said.is_some() {
                        warn!(target: "engine", "Chrome's own sandbox cannot run here ({}): starting it with --no-sandbox",
                              said.unwrap().rsplit("] ").next().unwrap_or("?").chars().take(160).collect::<String>());
                        self.no_sandbox = true;
                        continue;
                    }
                    let tail = tail.join("\n");
                    error!(target: "engine", "Chrome did not start{}", if tail.is_empty() { String::new() } else { format!(": {}", &tail[tail.len().saturating_sub(600)..]) });
                    self.shared.set_room("failed");
                    return None;
                }
            }
        }
    }

    async fn stop_browser(&self) {
        let b = self.shared.browser.lock().unwrap().take();
        *self.shared.session.lock().unwrap() = None;
        if let Some(b) = b {
            b.stop().await;
        }
    }

    /// A fresh tab with the shim, navigated to the room; the tabs before it closed.
    async fn load(&self) -> Result<(), CdpError> {
        let b = self.shared.browser().ok_or(CdpError::Gone)?;
        let t = Duration::from_secs(10);
        let target = b.call("Target.createTarget", json!({ "url": "about:blank" }), None, t).await?["targetId"].as_str().unwrap_or_default().to_string();
        let session = b.call("Target.attachToTarget", json!({ "targetId": target, "flatten": true }), None, t).await?["sessionId"]
            .as_str().unwrap_or_default().to_string();
        self.shared.crashed.store(false, Ordering::Relaxed);
        *self.shared.session.lock().unwrap() = Some(session.clone());
        let (w, h) = self.cfg.window;
        for (method, params) in [
            ("Page.enable", json!({})), ("Runtime.enable", json!({})), ("Log.enable", json!({})), ("Network.enable", json!({})),
            ("Inspector.enable", json!({})),
            ("Emulation.setDeviceMetricsOverride", json!({ "width": w, "height": h, "deviceScaleFactor": 1, "mobile": false })),
            ("Fetch.enable", json!({ "patterns": [{ "urlPattern": format!("{}/*", self.origin) }] })),
            ("Page.addScriptToEvaluateOnNewDocument", json!({ "source": self.shim() })),
        ] {
            b.call(method, params, Some(&session), t).await?;
        }
        if let Ok(targets) = b.call("Target.getTargets", json!({}), None, t).await {
            for ti in targets["targetInfos"].as_array().into_iter().flatten() {
                if ti["type"] == "page" && ti["targetId"].as_str() != Some(&target) {
                    let _ = b.post("Target.closeTarget", json!({ "targetId": ti["targetId"] }), None);
                }
            }
        }
        let r = b.call("Page.navigate", json!({ "url": self.cfg.room_url }), Some(&session), READY).await?;
        if let Some(e) = r["errorText"].as_str().filter(|e| !e.is_empty()) {
            return Err(CdpError::Failed(format!("could not load {}: {e}", self.cfg.room_url)));
        }
        let loader = r["loaderId"].as_str().unwrap_or_default().to_string();
        let mut status = None;
        for _ in 0..20 {   // the document's status comes as an event, usually before navigate answers
            status = {
                let mut docs = self.shared.documents.lock().unwrap();
                docs.iter().position(|(l, _)| *l == loader).map(|i| docs.remove(i).1)
            };
            if status.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if let Some(s) = status.filter(|s| *s >= 400) {
            return Err(CdpError::Failed(format!("could not load {}: HTTP {s}", self.cfg.room_url)));
        }
        Ok(())
    }

    fn shim(&self) -> String {
        SHIM.replace("\"__URL__\"", &json!(self.cfg.visit_url).to_string())
            .replace("\"__TOKEN__\"", &json!(self.cfg.token).to_string())
            .replace("__TICK_IDLE__", &self.cfg.tick_idle.to_string())
    }

    /// One question to the page: sets VISIT_ENGINE.idle; {frames, people, ready}, or None if unanswered.
    async fn probe(&self, b: &Browser) -> Option<Value> {
        let session = self.shared.session()?;
        let r = b.call("Runtime.evaluate", json!({ "expression": PROBE, "returnByValue": true, "timeout": 5000 }), Some(&session), Duration::from_secs(6)).await;
        match r {
            Ok(r) => r["result"]["value"].as_str().and_then(|v| serde_json::from_str(v).ok()),
            Err(e) => {
                debug!(target: "engine", "probe: {e}");
                None
            }
        }
    }

    /// A load that did not get there, or a room that went: said, and a wait before the next try.
    async fn fail(&mut self, reason: &str, backoff: u64) {
        self.shared.set_room("failed");
        error!(target: "engine", "room: failed ({reason}); loading again in {backoff} s");
        if let (Some(b), Some(_)) = (self.shared.browser(), self.shared.session()) {
            if let Ok(targets) = b.call("Target.getTargets", json!({}), None, Duration::from_secs(2)).await {
                for ti in targets["targetInfos"].as_array().into_iter().flatten().filter(|t| t["type"] == "page") {
                    let _ = b.post("Target.closeTarget", json!({ "targetId": ti["targetId"] }), None);
                }
            }
        }
        *self.shared.session.lock().unwrap() = None;
        self.shared.reloads.fetch_add(1, Ordering::Relaxed);
        self.wait(Duration::from_secs(backoff)).await;
    }
}

/// The browser's events: the key on the room's own requests, documents' statuses, the page's console and
/// errors into the log, a crash noticed.
async fn events(mut rx: mpsc::UnboundedReceiver<Value>, shared: Arc<Shared>) {
    while let Some(m) = rx.recv().await {
        let p = &m["params"];
        let session = m["sessionId"].as_str();
        match m["method"].as_str().unwrap_or_default() {
            "Fetch.requestPaused" => {
                // The key on every request to the room's origin (the pattern given to Fetch.enable), on nothing else.
                let mut headers: Vec<Value> = p["request"]["headers"].as_object().into_iter().flatten()
                    .filter(|(k, _)| !k.eq_ignore_ascii_case("authorization"))
                    .map(|(k, v)| json!({ "name": k, "value": v })).collect();
                headers.push(json!({ "name": "Authorization", "value": format!("Bearer {}", shared.key) }));
                if let Some(b) = shared.browser() {
                    let _ = b.post("Fetch.continueRequest", json!({ "requestId": p["requestId"], "headers": headers }), session);
                }
            }
            "Network.responseReceived" if p["type"] == "Document" => {
                let mut docs = shared.documents.lock().unwrap();
                docs.push((p["loaderId"].as_str().unwrap_or_default().to_string(), p["response"]["status"].as_i64().unwrap_or(0)));
                if docs.len() > 32 {
                    docs.remove(0);   // frames' documents, never asked for
                }
            }
            "Runtime.consoleAPICalled" => {
                let text = p["args"].as_array().into_iter().flatten().map(describe).collect::<Vec<_>>().join(" ");
                match p["type"].as_str().unwrap_or_default() {
                    "error" | "assert" => error!(target: "engine", "page: {text}"),
                    "warning" => warn!(target: "engine", "page: {text}"),
                    "debug" | "trace" | "count" | "timeEnd" => debug!(target: "engine", "page: {text}"),
                    _ => info!(target: "engine", "page: {text}"),
                }
            }
            "Runtime.exceptionThrown" => {
                let d = &p["exceptionDetails"];
                let text = d["exception"]["description"].as_str().or(d["text"].as_str()).unwrap_or("?");
                match d["url"].as_str() {
                    Some(u) => error!(target: "engine", "page: {text} ({u}:{})", d["lineNumber"]),
                    None => error!(target: "engine", "page: {text}"),
                }
            }
            "Log.entryAdded" => {
                let e = &p["entry"];
                let text = format!("page: {}{}", e["text"].as_str().unwrap_or(""), e["url"].as_str().map(|u| format!(" ({u})")).unwrap_or_default());
                match e["level"].as_str().unwrap_or_default() {
                    "error" => error!(target: "engine", "{text}"),
                    "warning" => warn!(target: "engine", "{text}"),
                    "verbose" => debug!(target: "engine", "{text}"),
                    _ => info!(target: "engine", "{text}"),
                }
            }
            "Inspector.targetCrashed" if session.is_some() && session == shared.session().as_deref() => shared.crashed.store(true, Ordering::Relaxed),
            "Target.detachedFromTarget" if p["sessionId"].as_str().is_some() && p["sessionId"].as_str() == shared.session().as_deref() => {
                shared.crashed.store(true, Ordering::Relaxed)
            }
            _ => {}
        }
    }
}

/// A console argument, as text.
fn describe(a: &Value) -> String {
    match &a["value"] {
        Value::String(s) => s.clone(),
        Value::Null => a["unserializableValue"].as_str().or(a["description"].as_str()).or(a["type"].as_str()).unwrap_or("").to_string(),
        v => v.to_string(),
    }
}

async fn health(State(s): State<Arc<Shared>>) -> Json<Value> {
    let (room, since) = *s.room.lock().unwrap();
    Json(json!({ "ok": room != "failed", "version": s.version, "room": room, "since": since, "reloads": s.reloads.load(Ordering::Relaxed) }))
}

/// The test aid (ENGINE_DEBUG): the body run in the page, its value as JSON.
async fn debug_eval(State(s): State<Arc<Shared>>, body: String) -> (StatusCode, Json<Value>) {
    let (Some(b), Some(session)) = (s.browser(), s.session()) else { return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "no page" }))) };
    let r = b.call("Runtime.evaluate", json!({ "expression": body, "returnByValue": true, "awaitPromise": true, "timeout": 10000 }),
                   Some(&session), Duration::from_secs(12)).await;
    match r {
        Ok(r) if r.get("exceptionDetails").is_some() => {
            let d = &r["exceptionDetails"];
            let e = d["exception"]["description"].as_str().or(d["text"].as_str()).unwrap_or("exception");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e })))
        }
        Ok(r) => (StatusCode::OK, Json(json!({ "value": r["result"]["value"] }))),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))),
    }
}

/// The test aid: the page's renderer, crashed.
async fn debug_crash(State(s): State<Arc<Shared>>) -> (StatusCode, Json<Value>) {
    match (s.browser(), s.session()) {
        (Some(b), Some(session)) => {
            let _ = b.post("Page.crash", json!({}), Some(&session));
            (StatusCode::OK, Json(json!({ "value": null })))
        }
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "no page" }))),
    }
}

/// What the browser's processes hold together, in MiB. On Linux their anonymous and shared memory, each page
/// counted once (Pss from /proc/<pid>/smaps_rollup; else RssAnon and RssShmem): a plain sum of resident sizes
/// counts the binary in every process, an idle browser near 1 GB. Elsewhere, their resident sizes.
#[cfg(target_os = "linux")]
fn memory_mib(pid: u32) -> u64 {
    let mut by_parent: std::collections::HashMap<u32, Vec<u32>> = Default::default();
    for e in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
        let Some(p) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{p}/stat")) else { continue };
        let Some(ppid) = stat.rsplit_once(')').and_then(|(_, r)| r.split_whitespace().nth(1)).and_then(|x| x.parse().ok()) else { continue };
        by_parent.entry(ppid).or_default().push(p);
    }
    let kib = |path: String, keys: &[&str]| -> Option<u64> {
        let s = std::fs::read_to_string(path).ok()?;
        let v: Vec<u64> = s.lines().filter(|l| keys.iter().any(|k| l.starts_with(k))).filter_map(|l| l.split_whitespace().nth(1)?.parse().ok()).collect();
        (!v.is_empty()).then(|| v.iter().sum())
    };
    let (mut total, mut todo) = (0u64, vec![pid]);
    while let Some(p) = todo.pop() {
        total += kib(format!("/proc/{p}/smaps_rollup"), &["Pss_Anon:", "Pss_Shmem:"])
            .or_else(|| kib(format!("/proc/{p}/status"), &["RssAnon:", "RssShmem:"])).unwrap_or(0);
        todo.extend(by_parent.get(&p).into_iter().flatten());
    }
    total / 1024
}

#[cfg(not(target_os = "linux"))]
fn memory_mib(pid: u32) -> u64 {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let mut total = 0u64;
    let mut todo = vec![Pid::from_u32(pid)];
    while let Some(p) = todo.pop() {
        if let Some(proc_) = sys.process(p) {
            total += proc_.memory();
        }
        todo.extend(sys.processes().iter().filter(|(_, c)| c.parent() == Some(p)).map(|(k, _)| *k));
    }
    total / (1024 * 1024)
}

#[cfg(test)]
mod tests {
    use super::insecure;

    #[test]
    fn a_room_off_loopback_over_http_is_made_a_secure_context() {
        assert_eq!(insecure("http://board:3001"), Some("http://board:3001"));
        assert_eq!(insecure("http://192.168.1.5"), Some("http://192.168.1.5"));
        for secure in ["https://board.example", "http://127.0.0.1:3001", "http://localhost:3001", "http://room.localhost", "http://[::1]:3001"] {
            assert_eq!(insecure(secure), None, "{secure}");
        }
    }
}
