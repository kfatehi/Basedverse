//! auth-client (../SPEC.md): a workroom's sign-in. It keeps the owner's account (made in a terminal, never in a
//! browser), checks passwords, makes and checks sessions and API keys, and hands visit-client's port and token to a
//! signed-in session. It listens on 127.0.0.1 only, and only the workroom's server talks to it, with its service
//! token. Its data is in Visit's own Postgres, in a schema and as a role of its own.
mod api;
mod cli;
mod db;
mod secret;

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use clap::{Parser, Subcommand};
use tracing::error;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Parser)]
#[command(version, about = "A workroom's sign-in: the owner's account, sessions and API keys, for its server on 127.0.0.1 (auth/SPEC.md)",
          args_conflicts_with_subcommands = true)]
struct Args {
    #[command(subcommand)]
    cmd: Option<Cmd>,
    /// Its database: Visit's own, as auth-client's role: postgres://auth:password@host:port/database.
    #[arg(long, env = "AUTH_DATABASE_URL", hide_env_values = true, global = true)]
    database: Option<String>,
    /// The port on 127.0.0.1 it answers on.
    #[arg(long, env = "AUTH_PORT", default_value_t = 7403)]
    port: u16,
    /// A file holding the service token the workroom's server sends (at least 32 characters, new each run; the
    /// launcher writes it, readable by the user only).
    #[arg(long, env = "AUTH_TOKEN_FILE")]
    token_file: Option<PathBuf>,
    /// A session ends after this long unused (a number and s, m, h or d).
    #[arg(long, env = "AUTH_IDLE", default_value = "7d", value_parser = secret::duration)]
    idle: Duration,
    /// ...and after this long in all.
    #[arg(long, env = "AUTH_MAX_AGE", default_value = "30d", value_parser = secret::duration)]
    max_age: Duration,
    /// visit-client's port, for /v1/visit (the same as visit-client is given).
    #[arg(long, env = "VISIT_PORT", default_value_t = 7401)]
    visit_port: u16,
    /// visit-client's token file, read afresh for each /v1/visit; none: /v1/visit answers 404.
    #[arg(long, env = "VISIT_TOKEN_FILE")]
    visit_token_file: Option<PathBuf>,
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
    /// Makes the database ready for auth-client, or brings it up to date after an upgrade.
    Migrate {
        /// Only say where it is, changing nothing.
        #[arg(long)]
        status: bool,
        /// A superuser's URL: first make visit-client's and auth-client's roles plain ones, each with its own
        /// schema (once, and after a password changes). Only for this: it is kept from the runs.
        #[arg(long, env = "VISIT_DATABASE_ADMIN_URL", hide_env_values = true)]
        admin: Option<String>,
        /// visit-client's URL, with --admin: its role and password, as they will be.
        #[arg(long, env = "VISIT_DATABASE_URL", hide_env_values = true)]
        visit_database: Option<String>,
        /// With --admin, when visit-client still uses the superuser (a database made before 0.21): the superuser's
        /// URL as it will be, under another name and password.
        #[arg(long, env = "VISIT_DATABASE_NEW_ADMIN_URL", hide_env_values = true)]
        new_admin: Option<String>,
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

/// How it ends: 0 done; 1 it failed; 2 bad flags; 5 the database is not at the schema it needs (`migrate`).
#[tokio::main]
async fn main() -> ExitCode {
    let a = Args::parse();
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_env("AUTH_LOG").unwrap_or_else(|_| "info".into()))
        .with_writer(std::io::stderr).init();
    let Some(url) = a.database.clone() else {
        eprintln!("auth-client: its database is required: --database or AUTH_DATABASE_URL (postgres://auth:password@host:port/database)");
        return ExitCode::from(2);
    };
    let done = match a.cmd {
        None => return serve(a, url).await,
        Some(Cmd::Migrate { status, admin, visit_database, new_admin }) => match (admin, status) {
            (Some(admin), false) => match visit_database {
                Some(visit) => db::admin(&admin, &visit, &url, new_admin.as_deref()).await,
                None => Err(anyhow::anyhow!("with --admin, visit-client's URL as it will be: --visit-database or VISIT_DATABASE_URL")),
            },
            _ => db::migrate(&url, status).await,
        }
        .map(|lines| lines.iter().for_each(|l| println!("{l}"))),
        Some(cmd) => match db::open(&url).await {
            Err(e) => {
                eprintln!("auth-client: {e:#}");
                return ExitCode::from(5);
            }
            Ok(c) => match cmd {
                Cmd::User { cmd: UserCmd::Add { name, password_stdin } } => cli::user_add(&c, &name, password_stdin).await,
                Cmd::User { cmd: UserCmd::List } => cli::user_list(&c).await,
                Cmd::User { cmd: UserCmd::Remove { name } } => cli::user_remove(&c, &name).await,
                Cmd::Passwd { name, password_stdin } => cli::passwd(&c, &name, password_stdin).await,
                Cmd::Sessions { name } => cli::sessions(&c, name.as_deref()).await,
                Cmd::Revoke { session, user } => cli::revoke(&c, session.as_deref(), user.as_deref()).await,
                Cmd::Key { cmd: KeyCmd::Add { label } } => cli::key_add(&c, &label).await,
                Cmd::Key { cmd: KeyCmd::List } => cli::key_list(&c).await,
                Cmd::Key { cmd: KeyCmd::Revoke { label } } => cli::key_revoke(&c, &label).await,
                Cmd::Migrate { .. } => unreachable!(),
            },
        },
    };
    match done {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("auth-client: {e:#}");
            ExitCode::FAILURE
        }
    }
}

async fn serve(a: Args, url: String) -> ExitCode {
    let token = match &a.token_file {
        None => return bad_flags("a service token is required: --token-file (or AUTH_TOKEN_FILE)"),
        Some(f) => match std::fs::read_to_string(f) {
            Ok(t) if t.trim().len() >= 32 => {
                #[cfg(unix)]
                if std::fs::metadata(f).is_ok_and(|m| std::os::unix::fs::PermissionsExt::mode(&m.permissions()) & 0o077 != 0) {
                    tracing::warn!("--token-file {}: others on this machine can read it (chmod 600 it)", f.display());
                }
                t.trim().to_string()
            }
            Ok(_) => return bad_flags(&format!("--token-file {}: a token of at least 32 characters", f.display())),
            Err(e) => return bad_flags(&format!("--token-file {}: {e}", f.display())),
        },
    };
    if a.idle > a.max_age {
        return bad_flags("--idle is at most --max-age");
    }
    let client = match db::open(&url).await {
        Ok(c) => c,
        Err(e) => {
            error!("{e:#}");
            return ExitCode::from(5);
        }
    };
    let cfg = api::Config { database: url, port: a.port, token, idle: a.idle, max_age: a.max_age, visit: a.visit_token_file.map(|f| (a.visit_port, f)) };
    match api::serve(cfg, client).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            error!("{e:#}");
            ExitCode::FAILURE
        }
    }
}

fn bad_flags(msg: &str) -> ExitCode {
    eprintln!("auth-client: {msg}");
    ExitCode::from(2)
}
