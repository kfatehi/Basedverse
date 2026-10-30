//! The workroom's Postgres (../../V2.md 4): the one inside visit (runtime.rs), its data in the workroom's data
//! directory, run as visit's child on 127.0.0.1 while visit runs (or while a command needs it), its roles and
//! schemas made right and brought up to date at every start. visit's own code and auth's talk to it as they did to
//! a Postgres beside them.
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use postgresql_embedded::{PostgreSQL, Settings};
use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

use crate::runtime;

/// The database, in the cluster: visit's and auth's schemas are in it, each its own role's.
const DATABASE: &str = "visit";

/// The roles' passwords, made at the first start and kept in `postgres/secrets` (the user's only).
#[derive(Serialize, Deserialize)]
struct Secrets {
    superuser: String,
    visit: String,
    auth: String,
}

/// A running Postgres for one workroom, and how to reach it as each role.
pub struct Pg {
    server: Option<PostgreSQL>,
    port: u16,
    secrets_: Secrets,
    pub bin: PathBuf,
    _lock: Option<fs::File>,
}

/// Who has the workroom: this process now (it runs Postgres, and stops it when done), or a `visit` that is
/// running already (its Postgres is used as it is).
pub enum Hold {
    Mine,
    Running,
}

impl Pg {
    pub fn superuser_url(&self, db: &str) -> String {
        url("postgres", &self.secrets_.superuser, self.port, db)
    }
    pub fn visit_url(&self) -> String {
        url("visit", &self.secrets_.visit, self.port, DATABASE)
    }
    pub fn auth_url(&self) -> String {
        url("auth", &self.secrets_.auth, self.port, DATABASE)
    }
    pub fn port(&self) -> u16 {
        self.port
    }
    pub fn superuser_password(&self) -> &str {
        &self.secrets_.superuser
    }

    /// Stops it, if this process started it (a fast shutdown: sessions ended, nothing lost).
    pub async fn stop(mut self) {
        if let Some(server) = self.server.take() {
            match server.stop().await {
                Ok(()) => info!("Postgres stopped"),
                Err(e) => warn!("Postgres did not stop: {e}"),
            }
        }
    }
}

fn url(user: &str, password: &str, port: u16, db: &str) -> String {
    format!("postgres://{user}:{password}@127.0.0.1:{port}/{db}")
}

/// The workroom in `data`: for a run (`want_mine`: it must be this process's, a second `visit` for the same
/// workroom refused), or for a command (a running `visit`'s Postgres used, else one started for the command).
/// Either way it is up, its roles made and its schemas up to date when this returns. `port`: the one it listens on
/// (VISIT_PG_PORT, for other programs of the workroom to share the cluster), refused if taken; none, a free one.
pub async fn open(data: &Path, want_mine: bool, port: Option<u16>) -> Result<(Pg, Hold)> {
    let dir = data.join("postgres");
    fs::create_dir_all(&dir).with_context(|| format!("making {}", dir.display()))?;
    let bin = runtime::unpacked(&runtime::POSTGRES)?.join("bin");
    let lock = fs::OpenOptions::new().create(true).truncate(false).write(true).open(data.join("visit.lock"))?;
    let mine = match lock.try_lock() {
        Ok(()) => true,
        Err(fs::TryLockError::WouldBlock) => false,
        Err(fs::TryLockError::Error(e)) => return Err(e).context("visit.lock"),
    };
    if !mine {
        if want_mine {
            bail!("this workroom's visit is running already ({})", data.display());
        }
        let secrets_ = read_secrets(&dir)?;
        let port = running_port(&dir.join("data")).ok_or_else(|| anyhow!("this workroom's visit is starting: try again in a moment"))?;
        return Ok((Pg { server: None, port, secrets_, bin, _lock: None }, Hold::Running));
    }
    let fresh = !dir.join("data/PG_VERSION").exists();
    if fresh {
        initdb(&bin, &dir).await?;
    }
    let secrets_ = read_secrets(&dir)?;
    write_hba(&dir.join("data"))?;
    let port = match port {
        Some(p) => free(p)?,
        None => std::net::TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port(),
    };
    let mut settings = Settings::new();
    settings.installation_dir = bin.parent().unwrap().to_path_buf();
    settings.trust_installation_dir = true;
    settings.data_dir = dir.join("data");
    settings.password_file = dir.join("pwfile");
    settings.password = secrets_.superuser.clone();
    settings.host = "127.0.0.1".into();
    settings.port = port;
    settings.temporary = false;
    settings.timeout = Some(Duration::from_secs(60));
    settings.configuration = HashMap::from([("listen_addresses".to_string(), "127.0.0.1".to_string())]);
    #[cfg(unix)]
    settings.configuration.insert("unix_socket_directories".into(), "''".into());
    let mut server = PostgreSQL::new(settings);
    if dir.join("data/postmaster.pid").exists() {
        // A Postgres left by a visit that did not stop it (killed): ours to stop, as this process has the lock.
        info!("stopping a Postgres a visit left running");
        let _ = server.stop().await;
    }
    server.start().await.map_err(|e| anyhow!("Postgres did not start: {e} (its log: {})", dir.join("data/start.log").display()))?;
    info!(port, version = runtime::POSTGRES.version, "Postgres started");
    let pg = Pg { server: Some(server), port, secrets_, bin, _lock: Some(lock) };
    if let Err(e) = ready(&pg, fresh).await {
        pg.stop().await;
        return Err(e);
    }
    Ok((pg, Hold::Mine))
}

/// The cluster, the first time: `initdb` with the built-in C.UTF-8 locale (the same sorting on every platform),
/// SCRAM passwords on 127.0.0.1 only, and the roles' passwords made.
async fn initdb(bin: &Path, dir: &Path) -> Result<()> {
    let secrets_ = Secrets { superuser: secret(), visit: secret(), auth: secret() };
    write_private(&dir.join("secrets"), &serde_json::to_vec_pretty(&secrets_)?)?;
    let pwfile = dir.join("pwfile");
    write_private(&pwfile, secrets_.superuser.as_bytes())?;
    let data = dir.join("data");
    let _ = fs::remove_dir_all(&data);   // an initdb that did not finish
    info!("making the workroom's database ({})", data.display());
    let out = tokio::process::Command::new(bin.join(exe("initdb")))
        .arg("-D").arg(&data)
        .args(["-U", "postgres", "-A", "scram-sha-256", "-E", "UTF8", "--locale-provider=builtin", "--builtin-locale=C.UTF-8"])
        .arg(format!("--pwfile={}", pwfile.display()))
        .output().await.context("initdb")?;
    if !out.status.success() {
        bail!("initdb: {}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    }
    Ok(())
}

/// Who may connect: the roles, with their passwords, from this machine only (written at every start).
fn write_hba(data: &Path) -> Result<()> {
    fs::write(data.join("pg_hba.conf"), "# Written by visit at every start (V2.md 4): its roles, with passwords, from this machine only.\n\
        host all all 127.0.0.1/32 scram-sha-256\n")?;
    Ok(())
}

/// The roles and schemas made right (auth's role code: visit and auth, each plain, each with its schema), then
/// each schema brought up to date as its own role.
async fn ready(pg: &Pg, fresh: bool) -> Result<()> {
    let admin = pg.superuser_url("postgres");
    let c = auth::db::connect(&admin).await?;
    if c.query_opt("SELECT 1 FROM pg_database WHERE datname = $1", &[&DATABASE]).await?.is_none() {
        c.batch_execute(&format!("CREATE DATABASE {DATABASE}")).await?;
    }
    drop(c);
    for line in auth::db::admin(&pg.superuser_url(DATABASE), &pg.visit_url(), &pg.auth_url(), None).await? {
        debug!("{line}");
    }
    for line in crate::db::migrate(&pg.visit_url(), false).await? {
        debug!("{line}");
    }
    if fresh {
        info!("the workroom's database is ready");
    }
    Ok(())
}

/// `visit import`: the data in an old database's visit and auth schemas (a 1.x workroom's) copied into this one's,
/// which must have none yet, with the pg_dump and pg_restore inside visit; each schema's bookkeeping of its
/// migrations left as this one has it. What it did, a line each.
pub async fn import(pg: &Pg, old: &str) -> Result<Vec<String>> {
    let c = auth::db::connect(&pg.superuser_url(DATABASE)).await?;
    let had: i64 = c.query_one("SELECT (SELECT count(*) FROM auth.users) + (SELECT count(*) FROM visit.messages) + (SELECT count(*) FROM visit.bans)", &[])
        .await?.get(0);
    if had > 0 {
        bail!("this workroom has data already (accounts, chat or bans): import into a new one (another VISIT_DATA_DIR)");
    }
    let dump = pg.bin.parent().unwrap().join(format!(".import-{}.dump", std::process::id()));
    let out = tokio::process::Command::new(pg.bin.join(exe("pg_dump")))
        .args(["--data-only", "--format=custom", "--schema=visit", "--schema=auth",
               "--exclude-table-data=visit.visit_migrations", "--exclude-table-data=auth.migrations"])
        .arg(format!("--file={}", dump.display())).arg(format!("--dbname={old}"))
        .output().await.context("pg_dump")?;
    if !out.status.success() {
        let _ = fs::remove_file(&dump);
        bail!("reading the old database: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    let out = tokio::process::Command::new(pg.bin.join(exe("pg_restore")))
        .args(["--data-only", "--disable-triggers", "--single-transaction", "--exit-on-error"])
        .arg(format!("--dbname={}", pg.superuser_url(DATABASE))).arg(&dump)
        .output().await.context("pg_restore")?;
    let _ = fs::remove_file(&dump);
    if !out.status.success() {
        bail!("writing it here: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    let mut lines = vec![format!("from {}:", auth::db::redact(old))];
    for (what, q) in [("accounts", "SELECT count(*) FROM auth.users"), ("API keys", "SELECT count(*) FROM auth.api_keys"),
                      ("chat lines", "SELECT count(*) FROM visit.messages"), ("pictures and voice messages", "SELECT count(*) FROM visit.media"),
                      ("whispers held", "SELECT count(*) FROM visit.held"), ("bans", "SELECT count(*) FROM visit.bans")] {
        let n: i64 = c.query_one(q, &[]).await?.get(0);
        lines.push(format!("  {what}: {n}"));
    }
    lines.push("imported: the old database can go once this workroom runs on it".into());
    Ok(lines)
}

fn read_secrets(dir: &Path) -> Result<Secrets> {
    let f = dir.join("secrets");
    serde_json::from_slice(&fs::read(&f).with_context(|| format!("{} (the database's passwords)", f.display()))?)
        .with_context(|| f.display().to_string())
}

/// The port of the Postgres running on `data`, from its `postmaster.pid` (its fourth line).
fn running_port(data: &Path) -> Option<u16> {
    fs::read_to_string(data.join("postmaster.pid")).ok()?.lines().nth(3)?.trim().parse().ok()
}

/// A fixed port, checked free on 127.0.0.1: nothing answers there (a program listening on every address included),
/// and it can be had. Taken, the start is refused: never another port, which the workroom's other programs would
/// not find.
fn free(port: u16) -> Result<u16> {
    let at = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let taken = |why: &str| anyhow!("VISIT_PG_PORT {port}: 127.0.0.1:{port} is {why}; stop what holds it, or give another port \
                                     (visit never takes another one of its own: the workroom's programs would not find it)");
    if std::net::TcpStream::connect_timeout(&at, Duration::from_millis(300)).is_ok() {
        return Err(taken("taken (something answers there)"));
    }
    std::net::TcpListener::bind(at).map_err(|e| taken(&format!("not free ({e})")))?;
    Ok(port)
}

fn secret() -> String {
    auth::secret::hex(&auth::secret::random(24))
}

/// A file only its user can read.
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut o = fs::OpenOptions::new();
    o.create(true).write(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    std::io::Write::write_all(&mut o.open(path).with_context(|| path.display().to_string())?, bytes)?;
    Ok(())
}

pub fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

#[cfg(test)]
mod tests {
    use super::free;

    #[test]
    fn a_fixed_port_is_taken_only_if_free() {
        let held = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = held.local_addr().unwrap().port();
        let e = free(port).unwrap_err().to_string();
        assert!(e.contains(&format!("VISIT_PG_PORT {port}")) && e.contains("taken"), "{e}");
        drop(held);
        assert_eq!(free(port).unwrap(), port);
    }
}
