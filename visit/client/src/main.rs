//! visit (../../V2.md): the one program a workroom needs; at its heart visit-client, Visit's local client
//! (../SPEC.md). One per workroom per machine. It also serves the workroom's sign-in (../../auth/SPEC.md, the `auth`
//! crate: its API in this process, `visit auth …` in a terminal). visit-client owns all networking
//! (the lobby session, the links to other visit-clients, the visits), keeps them across page reloads,
//! and serves the workroom's pages (the room's, the person's: engine/SPEC.md 3) on 127.0.0.1 only, or on a
//! container's own network, behind a token. What it keeps, it keeps in the workroom's data directory: its
//! database is the Postgres inside visit (pg.rs, runtime.rs; ../SPEC.md 8.12), run while it runs.
mod core;
mod db;
mod frames;
mod link;
mod land;
mod lobby;
mod media;
mod page;
mod pg;
mod runtime;
mod state;

use std::{path::PathBuf, process::ExitCode, time::Duration};

use clap::Parser;
use serde_json::json;
use tokio::{net::TcpListener, sync::mpsc};
use tracing::error;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Parser)]
#[command(name = "visit", version, long_version = long_version(), about = "Visit, the one program a workroom needs: the lobby, the links to other workrooms, the page on 127.0.0.1, the sign-in (V2.md)",
          after_help = "The sign-in's accounts, sessions and keys: visit auth --help")]
struct Args {
    /// The lobby's wss:// (or, to test, ws://127.0.0.1:...) URL.
    #[arg(long, env = "VISIT_LOBBY")]
    lobby: String,
    /// The office's name: 1-24 letters, digits, space, _ . -, starting and ending with a letter or digit.
    #[arg(long, env = "VISIT_NAME")]
    name: String,
    /// The sim, as name/version, shown to others.
    #[arg(long, env = "VISIT_SIM", default_value = "unknown/0")]
    sim: String,
    /// The port for the page.
    #[arg(long, env = "VISIT_PORT", default_value_t = 7401)]
    port: u16,
    /// The address it answers the page on: 127.0.0.1, or, in a container, 0.0.0.0 (its container's own network,
    /// where the workroom's server and the engine reach it by name; its port never published). Nothing else.
    #[arg(long, env = "VISIT_LISTEN", default_value = "127.0.0.1")]
    listen: std::net::IpAddr,
    /// The page token (at least 32 hex characters, new each run): the host's, and a page without a role (engine/SPEC.md
    /// 6.2). Prefer --token-file.
    #[arg(long, env = "VISIT_TOKEN", hide_env_values = true)]
    token: Option<String>,
    /// A file holding the page token.
    #[arg(long, env = "VISIT_TOKEN_FILE")]
    token_file: Option<PathBuf>,
    /// The user token (as the page token: new each run, at least 32 hex characters, another one): what the workroom's
    /// server relays a person with (engine/SPEC.md 6.3). Without one, no user connection is taken. Prefer --user-token-file.
    #[arg(long, env = "VISIT_USER_TOKEN", hide_env_values = true)]
    user_token: Option<String>,
    /// A file holding the user token.
    #[arg(long, env = "VISIT_USER_TOKEN_FILE")]
    user_token_file: Option<PathBuf>,
    /// How many visitors the office takes at once (0-8).
    #[arg(long, env = "VISIT_MAX_VISITORS", default_value_t = 3)]
    max_visitors: u8,
    /// Exit after this many seconds with no page connected (0: never).
    #[arg(long, env = "VISIT_IDLE_EXIT", default_value_t = 0)]
    idle_exit: u64,
    /// The relays for links, overriding the lobby's: "none", "default" (iroh's own), or comma-separated URLs.
    #[arg(long, env = "VISIT_RELAYS")]
    relays: Option<String>,
    /// The origins (scheme://host:port) the workroom's page may connect from, comma-separated; none: any page
    /// with the token. Naming the sim's own makes a token stolen somehow useless to another site.
    #[arg(long, env = "VISIT_ORIGINS", default_value = "")]
    origins: String,
    /// Where the workroom keeps everything (V2.md 3): its database, its state file, friends' landscapes. Default:
    /// the user's data folder, basedverse/<its name> (bin/setup writes it into the .env, so a new name keeps it).
    #[arg(long, env = "VISIT_DATA_DIR")]
    data_dir: Option<PathBuf>,
    /// A file where it keeps what outlasts a run: whether the office is out of the lobby (the page's
    /// leave_lobby), its key (so it is the same office to its friends), its door and its guests. Default: state.json
    /// in the data directory.
    #[arg(long, env = "VISIT_STATE_FILE")]
    state_file: Option<PathBuf>,
    /// A directory where it keeps friends' landscapes (the parts of their rooms that never change: sent once) and
    /// their plots to draw while they are away. Default: landscapes/ in the data directory.
    #[arg(long, env = "VISIT_CACHE_DIR")]
    cache_dir: Option<PathBuf>,
    /// The sign-in API (auth/SPEC.md 3), served by this program for the workroom's server: on when given the
    /// service token's file (at least 32 characters, new each run, readable by the user only).
    #[arg(long, env = "AUTH_TOKEN_FILE")]
    auth_token_file: Option<PathBuf>,
    /// The sign-in API's port.
    #[arg(long, env = "AUTH_PORT", default_value_t = 7403)]
    auth_port: u16,
    /// The address the sign-in API answers on: 127.0.0.1, or, in a container, 0.0.0.0 (as --listen).
    #[arg(long, env = "AUTH_LISTEN", default_value = "127.0.0.1")]
    auth_listen: std::net::IpAddr,
    /// A session ends after this long unused (a number and s, m, h or d).
    #[arg(long, env = "AUTH_IDLE", default_value = "7d", value_parser = auth::secret::duration)]
    auth_idle: Duration,
    /// ...and after this long in all.
    #[arg(long, env = "AUTH_MAX_AGE", default_value = "30d", value_parser = auth::secret::duration)]
    auth_max_age: Duration,
}

/// Which workroom a command is for: VISIT_DATA_DIR, or the default made from VISIT_NAME (as a run finds it).
#[derive(clap::Args)]
struct Which {
    /// The workroom's data directory.
    #[arg(long, env = "VISIT_DATA_DIR")]
    data_dir: Option<PathBuf>,
    /// The workroom's name, for its default data directory.
    #[arg(long, env = "VISIT_NAME")]
    name: Option<String>,
}

impl Which {
    fn dir(&self) -> anyhow::Result<PathBuf> {
        data_dir(self.data_dir.clone(), self.name.as_deref())
    }
}

/// The commands beside a run (V2.md 2.1); `visit auth …` is auth's own (auth::main_with).
#[derive(Parser)]
#[command(name = "visit", version)]
enum Command {
    /// A psql on the workroom's database, as its superuser (what follows goes to psql).
    Psql {
        #[command(flatten)]
        which: Which,
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Where the workroom's data is, what is inside this visit, and whether it runs.
    Status {
        #[command(flatten)]
        which: Which,
    },
}

/// A workroom's data directory: the one given, or basedverse/<name> in the user's data folder.
fn data_dir(given: Option<PathBuf>, name: Option<&str>) -> anyhow::Result<PathBuf> {
    match (given, name) {
        (Some(d), _) => Ok(d),
        (None, Some(n)) => runtime::default_data_dir(n),
        (None, None) => anyhow::bail!("which workroom: VISIT_DATA_DIR (--data-dir), or VISIT_NAME (--name) for its default"),
    }
}

/// What this visit is, for --version: its own version, and what is inside it.
fn long_version() -> &'static str {
    Box::leak(format!("{VERSION} (Postgres {})", runtime::POSTGRES.version).into_boxed_str())
}

/// Compares two secrets in time that does not depend on where they differ.
pub fn ct_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A lobby name: 1-24 letters, digits, space, _ . -, starting and ending with a letter or digit.
pub fn name_ok(n: &str) -> bool {
    let b = n.as_bytes();
    !b.is_empty()
        && b.len() <= 24
        && b.iter().all(|c| c.is_ascii_alphanumeric() || b" _.-".contains(c))
        && b[0].is_ascii_alphanumeric()
        && b[b.len() - 1].is_ascii_alphanumeric()
}

fn bad_flags(msg: &str) -> ExitCode {
    eprintln!("visit: {msg}");
    ExitCode::from(2)
}

fn main() -> ExitCode {
    // A blank setting (`VISIT_PORT=` in a .env, ../../.env.example) means its default, as .env files have it;
    // clap would take it as an empty value. Done before the runtime starts any thread.
    for (k, v) in std::env::vars_os() {
        if v.is_empty() && ["VISIT_", "AUTH_", "ENGINE_"].iter().any(|p| k.to_string_lossy().starts_with(p)) {
            std::env::remove_var(&k);
        }
    }
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("the tokio runtime");
    match std::env::args().nth(1).as_deref() {
        Some("auth") => return rt.block_on(auth_command()),
        Some("psql" | "status") => return rt.block_on(command(Command::parse())),
        _ => {}
    }
    rt.block_on(run())
}

/// `visit auth …` on the workroom's database: a running visit's, else one started for it (and stopped after).
/// Which workroom: VISIT_DATA_DIR or VISIT_NAME, or `--data-dir`/`--name` right after `auth`.
async fn auth_command() -> ExitCode {
    let mut rest: Vec<String> = std::env::args().skip(2).collect();
    let mut which = Which { data_dir: std::env::var_os("VISIT_DATA_DIR").map(PathBuf::from), name: std::env::var("VISIT_NAME").ok() };
    while let Some(flag) = rest.first().cloned() {
        let (k, v) = match flag.split_once('=') {
            Some((k, v)) => (k.to_string(), Some(v.to_string())),
            None => (flag.clone(), None),
        };
        if k != "--data-dir" && k != "--name" {
            break;
        }
        rest.remove(0);
        let Some(v) = v.or_else(|| (!rest.is_empty()).then(|| rest.remove(0))) else { return bad_flags(&format!("{k} needs a value")) };
        if k == "--data-dir" { which.data_dir = Some(v.into()) } else { which.name = Some(v) }
    }
    if rest.is_empty() || rest.iter().any(|a| a == "-h" || a == "--help" || a == "-V" || a == "--version") {
        return auth::main_with(std::iter::once("visit auth".to_string()).chain(rest), "").await;
    }
    with_database(&which, |pg| async move {
        auth::main_with(std::iter::once("visit auth".to_string()).chain(rest), &pg.auth_url()).await
    }).await
}

/// Runs `f` with the workroom's Postgres up: a running visit's, else started for it and stopped after.
async fn with_database<F, Fut>(which: &Which, f: F) -> ExitCode
where
    F: FnOnce(std::sync::Arc<pg::Pg>) -> Fut,
    Fut: std::future::Future<Output = ExitCode>,
{
    tracing_subscriber::fmt().with_writer(std::io::stderr)
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "visit=warn,auth=warn".into())).init();
    let dir = match which.dir() {
        Ok(d) => d,
        Err(e) => return bad_flags(&format!("{e:#}")),
    };
    let pg = match pg::open(&dir, false).await {
        Ok((pg, _)) => std::sync::Arc::new(pg),
        Err(e) => {
            eprintln!("visit: {e:#}");
            return ExitCode::from(5);
        }
    };
    let code = f(pg.clone()).await;
    if let Ok(pg) = std::sync::Arc::try_unwrap(pg) {
        pg.stop().await;
    }
    code
}

async fn command(c: Command) -> ExitCode {
    match c {
        Command::Psql { which, args } => with_database(&which, |pg| async move {
            let status = std::process::Command::new(pg.bin.join(pg::exe("psql")))
                .args(["-h", "127.0.0.1", "-p", &pg.port().to_string(), "-U", "postgres", "-d", "visit"])
                .args(&args)
                .env("PGPASSWORD", pg.superuser_password())
                .status();
            match status {
                Ok(s) => ExitCode::from(s.code().unwrap_or(1) as u8),
                Err(e) => {
                    eprintln!("visit psql: {e}");
                    ExitCode::FAILURE
                }
            }
        }).await,
        Command::Status { which } => {
            let dir = match which.dir() {
                Ok(d) => d,
                Err(e) => return bad_flags(&format!("{e:#}")),
            };
            println!("visit {VERSION}");
            println!("inside it: Postgres {} ({})", runtime::POSTGRES.version, runtime::POSTGRES.name);
            println!("data: {}", dir.display());
            match runtime::basedverse_dir() {
                Ok(b) => println!("runtime: {}", b.join("runtime").display()),
                Err(e) => println!("runtime: {e:#}"),
            }
            let running = std::fs::OpenOptions::new().write(true).open(dir.join("visit.lock"))
                .map(|f| matches!(f.try_lock(), Err(std::fs::TryLockError::WouldBlock))).unwrap_or(false);
            println!("running: {}", if running { "yes" } else { "no" });
            ExitCode::SUCCESS
        }
    }
}

async fn run() -> ExitCode {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "visit=info,auth=info,iroh=warn".into()))
        .init();
    let a = Args::parse();
    let token = match (&a.token, &a.token_file) {
        (_, Some(f)) => match std::fs::read_to_string(f) {
            Ok(t) => t.trim().to_string(),
            Err(e) => return bad_flags(&format!("--token-file {}: {e}", f.display())),
        },
        (Some(t), None) => t.trim().to_string(),
        (None, None) => return bad_flags("a token is required: --token-file (or --token)"),
    };
    if token.len() < 32 || !token.bytes().all(|c| c.is_ascii_hexdigit()) {
        return bad_flags("the token must be at least 32 hex characters");
    }
    let user_token = match (&a.user_token, &a.user_token_file) {
        (_, Some(f)) => match std::fs::read_to_string(f) {
            Ok(t) => Some(t.trim().to_string()),
            Err(e) => return bad_flags(&format!("--user-token-file {}: {e}", f.display())),
        },
        (Some(t), None) => Some(t.trim().to_string()),
        (None, None) => None,
    };
    if let Some(t) = &user_token {
        if t.len() < 32 || !t.bytes().all(|c| c.is_ascii_hexdigit()) {
            return bad_flags("the user token must be at least 32 hex characters");
        }
        if ct_eq(t, &token) {
            return bad_flags("the user token must not be the page token: each opens its own role");
        }
    }
    if !(a.listen.is_loopback() || a.listen.is_unspecified()) || a.listen.is_ipv6() {
        return bad_flags("--listen: 127.0.0.1 (this machine only), or 0.0.0.0 (a container's own network, its port never published)");
    }
    if !name_ok(&a.name) {
        return bad_flags("--name: 1-24 letters, digits, space, _ . -, starting and ending with a letter or digit");
    }
    if a.max_visitors > 8 {
        return bad_flags("--max-visitors: 0 to 8");
    }
    if !(a.lobby.starts_with("wss://") || a.lobby.starts_with("ws://")) {
        return bad_flags("--lobby: a ws:// or wss:// URL");
    }
    let data = match data_dir(a.data_dir.clone(), Some(&a.name)) {
        Ok(d) => d,
        Err(e) => return bad_flags(&format!("{e:#}")),
    };
    if let Err(e) = std::fs::create_dir_all(&data) {
        return bad_flags(&format!("--data-dir {}: {e}", data.display()));
    }
    let state_file = a.state_file.clone().unwrap_or_else(|| data.join("state.json"));
    let cache = a.cache_dir.clone().unwrap_or_else(|| data.join("landscapes"));
    let relays = a.relays.as_deref().map(|r| match r {
        "none" => link::Relays::Off,
        "default" => link::Relays::Default,
        urls => link::Relays::Custom(urls.split(',').map(|u| u.trim().to_string()).filter(|u| !u.is_empty()).collect()),
    });
    let (name, version) = a.sim.split_once('/').unwrap_or((a.sim.as_str(), ""));
    let sim = json!({ "name": name, "version": version });

    // 127.0.0.1, or a container's own network (--listen 0.0.0.0, its port never published): the page's side is never
    // reachable from another machine.
    let listener = match TcpListener::bind((a.listen, a.port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("visit-client: {}:{}: {e}", a.listen, a.port);
            return ExitCode::from(3);
        }
    };

    let (core_tx, core_rx) = mpsc::unbounded_channel();
    let (lobby_tx, lobby_rx) = mpsc::unbounded_channel();
    let (mut saved, fresh) = state::Saved::load(Some(&state_file));
    // The workroom's Postgres, started and made ready (its roles, its schemas up to date); then visit-client's
    // database, with bans an older state file kept moved into it.
    let pg = match pg::open(&data, true).await {
        Ok((pg, _)) => pg,
        Err(e) => {
            eprintln!("visit: {e:#}");
            return ExitCode::from(5);
        }
    };
    let database = pg.visit_url();
    let (client, mut loaded) = match db::open(&database, &saved.bans).await {
        Ok(x) => x,
        Err(e) => {
            eprintln!("visit: {e:#}");
            pg.stop().await;
            return ExitCode::from(5);   // (4: the lobby refused it)
        }
    };
    saved.bans = std::mem::take(&mut loaded.bans);
    let (db_tx, db_rx) = mpsc::unbounded_channel();
    tokio::spawn(db::run(database, client, db_rx, core_tx.clone()));
    let away = saved.away;
    let hello = lobby::Hello { name: a.name.clone(), sim, status: "available".into(), max_visitors: a.max_visitors };
    tokio::spawn(lobby::run(a.lobby.clone(), hello, lobby_rx, core_tx.clone(), away));
    let origins: Vec<String> = a.origins.split(',').map(|o| o.trim().trim_end_matches('/').to_string()).filter(|o| !o.is_empty()).collect();
    let state = page::PageState::new(token, user_token, origins, core_tx.clone());
    tokio::spawn(async move {
        if let Err(e) = page::serve(listener, state).await {
            error!("the page server stopped: {e}");
        }
    });
    // The sign-in, in this process: ready (its token, its database, its port) before this says it is.
    if let Some(token_file) = a.auth_token_file.clone() {
        let visit = a.token_file.clone().map(|f| (a.port, f));
        let serve = auth::Serve { database: pg.auth_url(), port: a.auth_port, listen: a.auth_listen, token_file, idle: a.auth_idle, max_age: a.auth_max_age, visit };
        match auth::serve_with(serve).await {
            Ok(api) => {
                let stopper = core_tx.clone();
                tokio::spawn(async move {
                    if let Err(e) = api.await {
                        error!("the sign-in API stopped: {e:#}");
                        let _ = stopper.send(core::Ev::Shutdown);
                    }
                });
            }
            Err(e) => {
                eprintln!("visit: the sign-in API: {e:#}");
                pg.stop().await;
                return ExitCode::from(5);
            }
        }
    }
    let ticker = core_tx.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if ticker.send(core::Ev::Tick).is_err() {
                return;
            }
        }
    });
    let stopper = core_tx.clone();
    tokio::spawn(async move {
        asked_to_stop().await;
        let _ = stopper.send(core::Ev::Shutdown);
    });

    println!("{}", json!({ "ready": true, "port": a.port, "version": VERSION, "proto": page::PROTO }));
    let lands = land::Lands::open(Some(cache));
    let code = core::Core::new(lobby_tx, core_tx, relays, a.max_visitors, a.idle_exit, saved, fresh, Some(state_file), lands, db_tx, loaded).run(core_rx).await;
    auth::STOPPING.store(true, std::sync::atomic::Ordering::Relaxed);
    pg.stop().await;
    ExitCode::from(code as u8)
}

/// Ctrl-C, or SIGTERM (what launchers send), on Unix.
#[cfg(unix)]
async fn asked_to_stop() {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
}

/// Ctrl-C, or its console closing, on Windows (where a launcher's kill ends a process without a word).
#[cfg(windows)]
async fn asked_to_stop() {
    let mut close = tokio::signal::windows::ctrl_close().expect("console close handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = close.recv() => {}
    }
}
