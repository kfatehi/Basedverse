//! visit (../../V2.md): the one program a workroom needs; at its heart visit-client, Visit's local client
//! (../SPEC.md). One per workroom per machine. It also serves the workroom's sign-in (../../auth/SPEC.md, the `auth`
//! crate: its API in this process, `visit auth …` in a terminal). visit-client owns all networking
//! (the lobby session, the links to other visit-clients, the visits), keeps them across page reloads,
//! and serves the workroom's pages (the room's, the person's: engine/SPEC.md 3) on 127.0.0.1 only, or on a
//! container's own network, behind a token. What it keeps, it keeps in its database
//! beside it (Postgres, ../SPEC.md 8.12), whose schema `visit-client migrate` makes.
mod core;
mod db;
mod frames;
mod link;
mod land;
mod lobby;
mod media;
mod page;
mod state;

use std::{path::PathBuf, process::ExitCode, time::Duration};

use clap::Parser;
use serde_json::json;
use tokio::{net::TcpListener, sync::mpsc};
use tracing::error;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Parser)]
#[command(name = "visit", version, about = "Visit, the one program a workroom needs: the lobby, the links to other workrooms, the page on 127.0.0.1, the sign-in (V2.md)",
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
    /// A file where it keeps what outlasts a run: whether the office is out of the lobby (the page's
    /// leave_lobby), its key (so it is the same office to its friends), its door and its guests; none: every
    /// start joins the lobby, with a new key and no guests.
    #[arg(long, env = "VISIT_STATE_FILE")]
    state_file: Option<PathBuf>,
    /// A directory where it keeps friends' landscapes (the parts of their rooms that never change: sent once) and
    /// their plots to draw while they are away; none: beside the state file (landscapes/), or for this run only.
    #[arg(long, env = "VISIT_CACHE_DIR")]
    cache_dir: Option<PathBuf>,
    /// Its database, beside it (required): postgres://user:password@host:port/database. Made ready, and brought up
    /// to date after each upgrade, by `visit-client migrate --database <url>`.
    #[arg(long, env = "VISIT_DATABASE_URL", hide_env_values = true)]
    database: Option<String>,
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
    /// The sign-in's database, as its own role: postgres://auth:password@host:port/database.
    #[arg(long, env = "AUTH_DATABASE_URL", hide_env_values = true)]
    auth_database: Option<String>,
}

/// `visit-client migrate`: makes the database ready for this visit-client, or brings it up to date after an
/// upgrade (each migration once, in order); `--status` says where it is, changing nothing.
#[derive(Parser)]
#[command(name = "visit-client migrate", version, about = "Makes visit-client's database ready, or brings it up to date (visit/SPEC.md 8.12)")]
struct Migrate {
    /// The database: postgres://user:password@host:port/database.
    #[arg(long, env = "VISIT_DATABASE_URL", hide_env_values = true)]
    database: String,
    /// Say where it is and what is pending, changing nothing.
    #[arg(long)]
    status: bool,
}

/// What a run with no database says: how to have one.
const NO_DATABASE: &str = "a database is required: --database postgres://user:password@host:port/database (or VISIT_DATABASE_URL).
Postgres in Docker, for example:
  docker run -d --name visit-db --restart unless-stopped -e POSTGRES_USER=visit -e POSTGRES_PASSWORD=<a password> \
    -v visit-db:/var/lib/postgresql/data -p 127.0.0.1:7432:5432 postgres:17-alpine
then, once (and after every upgrade): visit-client migrate --database postgres://visit:<a password>@127.0.0.1:7432/visit";

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
    eprintln!("visit-client: {msg}");
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
    if std::env::args().nth(1).as_deref() == Some("auth") {
        return rt.block_on(auth::main_with(std::iter::once("visit auth".to_string()).chain(std::env::args().skip(2))));
    }
    if std::env::args().nth(1).as_deref() == Some("migrate") {
        return rt.block_on(migrate(Migrate::parse_from(std::iter::once("visit-client migrate".to_string()).chain(std::env::args().skip(2)))));
    }
    rt.block_on(run())
}

async fn migrate(m: Migrate) -> ExitCode {
    match db::migrate(&m.database, m.status).await {
        Ok(lines) => {
            for l in lines {
                println!("{l}");
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("visit-client migrate: {e:#}");
            ExitCode::from(1)
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
    let Some(database) = a.database.clone().filter(|d| !d.is_empty()) else { return bad_flags(NO_DATABASE) };
    if a.auth_token_file.is_some() && a.auth_database.is_none() {
        return bad_flags("the sign-in API (--auth-token-file) needs its database: --auth-database (or AUTH_DATABASE_URL)");
    }
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
    let (mut saved, fresh) = state::Saved::load(a.state_file.as_deref());
    // The database, at the schema this visit-client needs (else it says what to run); bans an older state file
    // kept, moved into it.
    let (client, mut loaded) = match db::open(&database, &saved.bans).await {
        Ok(x) => x,
        Err(e) => {
            eprintln!("visit-client: {e:#}");
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
    if let (Some(token_file), Some(database)) = (a.auth_token_file.clone(), a.auth_database.clone()) {
        let visit = a.token_file.clone().map(|f| (a.port, f));
        let serve = auth::Serve { database, port: a.auth_port, listen: a.auth_listen, token_file, idle: a.auth_idle, max_age: a.auth_max_age, visit };
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
    let cache = a.cache_dir.clone().or_else(|| a.state_file.as_deref().map(|f| f.parent().unwrap_or(std::path::Path::new(".")).join("landscapes")));
    let lands = land::Lands::open(cache);
    let code = core::Core::new(lobby_tx, core_tx, relays, a.max_visitors, a.idle_exit, saved, fresh, a.state_file.clone(), lands, db_tx, loaded).run(core_rx).await;
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
