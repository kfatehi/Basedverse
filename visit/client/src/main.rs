//! visit-client: Visit's local client (../SPEC.md). One per workroom per machine. It owns all networking
//! (the lobby session, the links to other visit-clients, the visits), keeps them across page reloads,
//! and serves the workroom's page on 127.0.0.1 only, behind a token.
mod core;
mod frames;
mod link;
mod lobby;
mod page;

use std::{path::PathBuf, process::ExitCode, time::Duration};

use clap::Parser;
use serde_json::json;
use tokio::{net::TcpListener, sync::mpsc};
use tracing::error;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Parser)]
#[command(version, about = "Visit's local client: the lobby, the links to other workrooms, and the page on 127.0.0.1 (visit/SPEC.md)")]
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
    /// The port on 127.0.0.1 for the page.
    #[arg(long, env = "VISIT_PORT", default_value_t = 7401)]
    port: u16,
    /// The page token (at least 32 hex characters, new each run). Prefer --token-file.
    #[arg(long, env = "VISIT_TOKEN", hide_env_values = true)]
    token: Option<String>,
    /// A file holding the page token.
    #[arg(long, env = "VISIT_TOKEN_FILE")]
    token_file: Option<PathBuf>,
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
    eprintln!("visit-client: {msg}");
    ExitCode::from(2)
}

fn main() -> ExitCode {
    // A blank setting (`VISIT_PORT=` in a .env, ../../.env.example) means its default, as .env files have it;
    // clap would take it as an empty value. Done before the runtime starts any thread.
    for (k, v) in std::env::vars_os() {
        if v.is_empty() && k.to_string_lossy().starts_with("VISIT_") {
            std::env::remove_var(&k);
        }
    }
    tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("the tokio runtime").block_on(run())
}

async fn run() -> ExitCode {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "visit_client=info,iroh=warn".into()))
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
    if !name_ok(&a.name) {
        return bad_flags("--name: 1-24 letters, digits, space, _ . -, starting and ending with a letter or digit");
    }
    if a.max_visitors > 8 {
        return bad_flags("--max-visitors: 0 to 8");
    }
    if !(a.lobby.starts_with("wss://") || a.lobby.starts_with("ws://")) {
        return bad_flags("--lobby: a ws:// or wss:// URL");
    }
    let relays = a.relays.as_deref().map(|r| match r {
        "none" => link::Relays::Off,
        "default" => link::Relays::Default,
        urls => link::Relays::Custom(urls.split(',').map(|u| u.trim().to_string()).filter(|u| !u.is_empty()).collect()),
    });
    let (name, version) = a.sim.split_once('/').unwrap_or((a.sim.as_str(), ""));
    let sim = json!({ "name": name, "version": version });

    // 127.0.0.1 and nothing else: the page's side is never reachable from another machine.
    let listener = match TcpListener::bind(("127.0.0.1", a.port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("visit-client: 127.0.0.1:{}: {e}", a.port);
            return ExitCode::from(3);
        }
    };

    let (core_tx, core_rx) = mpsc::unbounded_channel();
    let (lobby_tx, lobby_rx) = mpsc::unbounded_channel();
    let hello = lobby::Hello { name: a.name.clone(), sim, status: "available".into(), max_visitors: a.max_visitors };
    tokio::spawn(lobby::run(a.lobby.clone(), hello, lobby_rx, core_tx.clone()));
    let origins: Vec<String> = a.origins.split(',').map(|o| o.trim().trim_end_matches('/').to_string()).filter(|o| !o.is_empty()).collect();
    let state = page::PageState::new(token, origins, core_tx.clone());
    tokio::spawn(async move {
        if let Err(e) = page::serve(listener, state).await {
            error!("the page server stopped: {e}");
        }
    });
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
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
        let _ = stopper.send(core::Ev::Shutdown);
    });

    println!("{}", json!({ "ready": true, "port": a.port, "version": VERSION, "proto": page::PROTO }));
    let code = core::Core::new(lobby_tx, core_tx, relays, a.max_visitors, a.idle_exit).run(core_rx).await;
    ExitCode::from(code as u8)
}
