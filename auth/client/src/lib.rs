//! auth (../SPEC.md): a workroom's sign-in, built into `visit` (../../V2.md): `visit` serves its API
//! ([`serve_with`]) and `visit auth …` is its terminal side ([`main_with`]), on the workroom's own database. It
//! keeps the owner's account (made in a terminal, never in a browser), checks passwords, makes and checks sessions
//! and API keys, and hands visit-client's port and token to a signed-in session. Its API listens on 127.0.0.1 (in a
//! container, on its container's own network: AUTH_LISTEN), and only the workroom's server talks to it, with its
//! service token. Its data is in the workroom's Postgres, in a schema and as a role of its own.
mod api;
mod cli;
pub mod db;
pub mod secret;

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use clap::{Parser, Subcommand};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Set when `visit` is stopping: its database going away is expected then, and not said.
pub static STOPPING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn stopping() -> bool {
    STOPPING.load(std::sync::atomic::Ordering::Relaxed)
}

#[derive(Parser)]
#[command(name = "visit auth", version, about = "A workroom's sign-in: the owner's account, sessions and API keys (auth/SPEC.md 2). \
On the workroom's own database: VISIT_DATA_DIR (or VISIT_NAME) says which workroom, as for visit itself.")]
struct Args {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Accounts: add, list, remove.
    User {
        #[command(subcommand)]
        cmd: UserCmd,
    },
    /// Sets a user's password, and ends their sessions.
    Passwd {
        name: String,
        /// The password, one line on stdin (for a script), not typed.
        #[arg(long)]
        password_stdin: bool,
    },
    /// The signed-in sessions (a user's, given one), and the last sign-ins tried.
    Sessions { name: Option<String> },
    /// Ends a session (as `sessions` shows it), or all of a user's.
    Revoke {
        session: Option<String>,
        #[arg(long)]
        user: Option<String>,
    },
    /// API keys for the owner's scripts and agents: add, list, revoke.
    Key {
        #[command(subcommand)]
        cmd: KeyCmd,
    },
}

#[derive(Subcommand)]
enum UserCmd {
    /// Makes an account: the password typed twice, without echo.
    Add {
        name: String,
        #[arg(long)]
        password_stdin: bool,
    },
    List,
    /// Removes an account, and its sessions.
    Remove { name: String },
}

#[derive(Subcommand)]
enum KeyCmd {
    /// Makes a key, printed once.
    Add { label: String },
    List,
    Revoke { label: String },
}

/// `visit auth <args>`: what auth-client was in a terminal (its first argument, the program's name, is skipped),
/// on `database`: the workroom's, as auth's own role (visit opens it, and gives it here).
/// How it ends: 0 done; 1 it failed; 2 bad flags; 5 the database is not at the schema it needs.
pub async fn main_with<I: IntoIterator<Item = String>>(args: I, database: &str) -> ExitCode {
    let a = match Args::try_parse_from(args) {
        Ok(a) => a,
        Err(e) => {
            let _ = e.print();
            return ExitCode::from(if e.use_stderr() { 2 } else { 0 });
        }
    };
    let c = match db::open(database).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("visit auth: {e:#}");
            return ExitCode::from(5);
        }
    };
    let done = match a.cmd {
        Cmd::User { cmd: UserCmd::Add { name, password_stdin } } => cli::user_add(&c, &name, password_stdin).await,
        Cmd::User { cmd: UserCmd::List } => cli::user_list(&c).await,
        Cmd::User { cmd: UserCmd::Remove { name } } => cli::user_remove(&c, &name).await,
        Cmd::Passwd { name, password_stdin } => cli::passwd(&c, &name, password_stdin).await,
        Cmd::Sessions { name } => cli::sessions(&c, name.as_deref()).await,
        Cmd::Revoke { session, user } => cli::revoke(&c, session.as_deref(), user.as_deref()).await,
        Cmd::Key { cmd: KeyCmd::Add { label } } => cli::key_add(&c, &label).await,
        Cmd::Key { cmd: KeyCmd::List } => cli::key_list(&c).await,
        Cmd::Key { cmd: KeyCmd::Revoke { label } } => cli::key_revoke(&c, &label).await,
    };
    match done {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("visit auth: {e:#}");
            ExitCode::FAILURE
        }
    }
}

/// The sign-in API inside a running `visit` (V2.md 2.1): its settings, and visit-client's port and token file for
/// `/v1/visit` (the same process: nothing to probe).
pub struct Serve {
    pub database: String,
    pub port: u16,
    pub listen: std::net::IpAddr,
    pub token_file: PathBuf,
    pub idle: Duration,
    pub max_age: Duration,
    pub visit: Option<(u16, PathBuf)>,
}

/// Readies the API: its token read, its database at the schema it needs, its port taken; then what serves it,
/// until it fails. A `visit` awaits this before it says it is ready, so a sign-in that cannot start stops it.
pub async fn serve_with(s: Serve) -> anyhow::Result<impl std::future::Future<Output = anyhow::Result<()>>> {
    let token = read_token(&s.token_file).map_err(|e| anyhow::anyhow!(e))?;
    if s.idle > s.max_age {
        anyhow::bail!("--auth-idle is at most --auth-max-age");
    }
    let client = db::open(&s.database).await?;
    let cfg = api::Config { database: s.database, listen: s.listen, port: s.port, token, idle: s.idle, max_age: s.max_age,
                            visit: s.visit, visit_probe: false };
    let listener = api::bind(&cfg).await?;
    Ok(api::serve_on(cfg, client, listener))
}

/// The service token in `f`: at least 32 characters (and a warning when others may read it).
fn read_token(f: &std::path::Path) -> Result<String, String> {
    match std::fs::read_to_string(f) {
        Ok(t) if t.trim().len() >= 32 => {
            #[cfg(unix)]
            if std::fs::metadata(f).is_ok_and(|m| std::os::unix::fs::PermissionsExt::mode(&m.permissions()) & 0o077 != 0) {
                tracing::warn!("--token-file {}: others on this machine can read it (chmod 600 it)", f.display());
            }
            Ok(t.trim().to_string())
        }
        Ok(_) => Err(format!("--token-file {}: a token of at least 32 characters", f.display())),
        Err(e) => Err(format!("--token-file {}: {e}", f.display())),
    }
}
