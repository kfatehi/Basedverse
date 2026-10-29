//! auth-client's database (../SPEC.md 5): Visit's own Postgres, in a schema of its own (`auth`), as a role of its
//! own (`auth`). Its schema is made by `auth-client migrate`, never by a run. `migrate --admin`, given a
//! superuser, first makes the roles: visit-client's and auth-client's, each a plain role owning its own schema,
//! so neither can read the other's tables; a database whose visit-client still uses the superuser is moved over.
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use tokio_postgres::{Client, NoTls};
use tracing::warn;

use crate::secret;

/// The schema's migrations, in order: (version, name, SQL). Each runs once, in a transaction of its own, recorded
/// in `auth.migrations`.
pub const MIGRATIONS: &[(i32, &str, &str)] = &[(1, "auth", include_str!("../migrations/0001_auth.sql"))];

/// The tables visit-client had in `public` up to 0.20: moved into its own schema, once.
const VISIT_TABLES: &[&str] = &["visit_migrations", "messages", "media", "message_media", "links", "bans"];

/// What a run tells the others when an account, a session or a key changes outside it (the terminal's commands):
/// they read them again.
pub const CHANGED: &str = "auth_changed";

/// The schema this auth-client needs: its newest migration's version.
pub fn latest() -> i32 {
    MIGRATIONS.last().map_or(0, |m| m.0)
}

/// A connection to the database at `url` (postgres://user:password@host:port/database: beside it, on this machine
/// or its own network, so no TLS), driven by a task of its own.
pub async fn connect(url: &str) -> Result<Client> {
    let (client, conn) = tokio_postgres::connect(url, NoTls).await.with_context(|| format!("cannot reach the database at {}", redact(url)))?;
    tokio::spawn(async move {
        if let Err(e) = conn.await {
            if !crate::stopping() {
                warn!("the database connection ended: {e}");
            }
        }
    });
    Ok(client)
}

/// A database URL without its password, to say where it is.
pub fn redact(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else { return "(not a postgres:// URL)".into() };
    match rest.rsplit_once('@') {
        Some((who, at)) => format!("{scheme}://{}@{at}", who.split(':').next().unwrap_or("")),
        None => url.to_string(),
    }
}

/// A postgres:// URL's user and password, percent-decoded.
pub fn url_user(url: &str) -> Result<(String, String)> {
    let rest = url.split_once("://").map(|x| x.1).ok_or_else(|| anyhow!("{}: not a postgres:// URL", redact(url)))?;
    let (who, _) = rest.rsplit_once('@').ok_or_else(|| anyhow!("{}: no user in it", redact(url)))?;
    let (user, password) = who.split_once(':').unwrap_or((who, ""));
    Ok((unescape(user), unescape(password)))
}

/// The same URL as another user, with their password.
pub fn url_as(url: &str, user: &str, password: &str) -> Result<String> {
    let (scheme, rest) = url.split_once("://").ok_or_else(|| anyhow!("{}: not a postgres:// URL", redact(url)))?;
    let at = rest.rsplit_once('@').map_or(rest, |x| x.1);
    Ok(format!("{scheme}://{}:{}@{at}", escape(user), escape(password)))
}

fn unescape(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match (b[i], b.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok())) {
            (b'%', Some(x)) => { out.push(x); i += 3; }
            (c, _) => { out.push(c); i += 1; }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn escape(s: &str) -> String {
    s.bytes().map(|c| if c.is_ascii_alphanumeric() || b"-._~".contains(&c) { (c as char).to_string() } else { format!("%{c:02X}") }).collect()
}

/// An identifier, quoted; a string, as an SQL literal (for statements that take no parameters: roles, passwords).
fn ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// The schema's version: the newest migration applied (0: none).
pub async fn version(c: &Client) -> Result<i32> {
    if !c.query_one("SELECT to_regclass('auth.migrations') IS NOT NULL", &[]).await?.get::<_, bool>(0) {
        return Ok(0);
    }
    Ok(c.query_one("SELECT COALESCE(MAX(version), 0) FROM auth.migrations", &[]).await?.get::<_, i32>(0))
}

/// `auth-client migrate`: brings the database to the schema this auth-client needs, each migration in a
/// transaction of its own, one run at a time (an advisory lock); or, `status`, only says where it is. Refuses a
/// database newer than it knows. What it did, a line each.
pub async fn migrate(url: &str, status: bool) -> Result<Vec<String>> {
    let mut c = connect(url).await?;
    c.query("SELECT pg_advisory_lock(7403)", &[]).await?;
    let at = version(&c).await?;
    if at > latest() {
        bail!("the database is at version {at}, newer than this auth-client knows ({}): use a newer auth-client", latest());
    }
    let pending: Vec<_> = MIGRATIONS.iter().filter(|m| m.0 > at).collect();
    let mut out = vec![format!("{}: at version {at}; this auth-client needs {}", redact(url), latest())];
    if status {
        out.extend(pending.iter().map(|(v, name, _)| format!("pending: {v} {name}")));
        if pending.is_empty() {
            out.push("up to date".into());
        }
        return Ok(out);
    }
    // Its schema, if there is none yet (made only then: making one, even IF NOT EXISTS, needs rights to the database
    // that auth-client's own role does not have, and need not).
    if c.query_opt("SELECT 1 FROM pg_namespace WHERE nspname = 'auth'", &[]).await?.is_none() {
        c.batch_execute("CREATE SCHEMA auth").await
            .context("its schema (auth): without the rights to make it, run `auth-client migrate --admin <a superuser's URL>` once")?;
    }
    c.batch_execute("CREATE TABLE IF NOT EXISTS auth.migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())").await?;
    for (v, name, sql) in pending {
        let t = c.transaction().await?;
        t.batch_execute(sql).await.with_context(|| format!("migration {v} ({name})"))?;
        t.execute("INSERT INTO auth.migrations (version, name) VALUES ($1, $2)", &[v, name]).await?;
        t.commit().await?;
        out.push(format!("applied: {v} {name}"));
    }
    if out.len() == 1 {
        out.push("up to date".into());
    }
    Ok(out)
}

/// The database for a run: reached (it may still be starting: tried for 30 s), and at the schema this auth-client
/// needs (else what to run).
pub async fn open(url: &str) -> Result<Client> {
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
    if at != latest() {
        bail!("the database {} is at version {at}; this auth-client needs {}: {}", redact(url), latest(),
              if at < latest() { "run `auth-client migrate` first" } else { "use a newer auth-client" });
    }
    Ok(c)
}

/// `auth-client migrate --admin <superuser URL>`: the database's roles made right, then the schema brought up to
/// date as auth-client's own role. visit-client's role (`visit_url`'s user) and auth-client's (`auth_url`'s) each
/// become a plain role with that URL's password, owning a schema of its name, the database's to connect to and
/// nobody else's. visit-client's tables in `public` (0.20's) move into its schema. A database made before has
/// visit-client using the superuser itself (its bootstrap one, which Postgres keeps a superuser): that superuser
/// is renamed and given `new_admin`'s user and password, so the name is free for the plain role. Run again, it
/// changes nothing but the passwords. What it did, a line each.
pub async fn admin(admin_url: &str, visit_url: &str, auth_url: &str, new_admin: Option<&str>) -> Result<Vec<String>> {
    let mut c = connect(admin_url).await?;
    let me: String = c.query_one("SELECT current_user::text", &[]).await?.get(0);
    if !c.query_one("SELECT rolsuper FROM pg_roles WHERE rolname = current_user", &[]).await?.get::<_, bool>(0) {
        bail!("--admin is a superuser's URL; {me} is not one");
    }
    let db: String = c.query_one("SELECT current_database()::text", &[]).await?.get(0);
    let ((visit, visit_pw), (auth, auth_pw)) = (url_user(visit_url)?, url_user(auth_url)?);
    for (who, pw) in [(&visit, &visit_pw), (&auth, &auth_pw)] {
        if !secret::name_ok(who) || pw.len() < 16 {
            bail!("{who:?}: a role's name (letters, digits, _ . -) and a password of 16 characters or more, in its URL");
        }
    }
    if visit == auth || auth == me {
        bail!("visit-client's role ({visit}), auth-client's ({auth}) and the superuser ({me}) are three roles");
    }
    let mut out = vec![format!("{}: as the superuser {me}", redact(admin_url))];

    // visit-client on the superuser (0.20's setup): the superuser gets another name, through a role of the moment
    // (a session cannot rename its own role).
    let mut passing = None;
    if me == visit {
        let new_admin = new_admin.ok_or_else(|| anyhow!(
            "visit-client uses this superuser ({me}): give --new-admin <its URL under a new name and password>, and it is renamed"))?;
        let (name, pw) = url_user(new_admin)?;
        if !secret::name_ok(&name) || name == visit || name == auth || pw.len() < 16 {
            bail!("--new-admin: another role's name, and a password of 16 characters or more");
        }
        if c.query_opt("SELECT 1 FROM pg_roles WHERE rolname = $1", &[&name]).await?.is_some() {
            bail!("--new-admin: a role {name} is there already");
        }
        let (tmp, tmp_pw) = (format!("auth_setup_{}", secret::hex(&secret::random(4))), secret::hex(&secret::random(16)));
        c.batch_execute(&format!("CREATE ROLE {} SUPERUSER LOGIN PASSWORD {}", ident(&tmp), lit(&tmp_pw))).await?;
        let t = connect(&url_as(admin_url, &tmp, &tmp_pw)?).await?;
        drop(c);
        t.batch_execute(&format!("ALTER ROLE {} RENAME TO {}; ALTER ROLE {} PASSWORD {}", ident(&me), ident(&name), ident(&name), lit(&pw))).await?;
        out.push(format!("the superuser {me} is now {name} (with --new-admin's password): {me} is visit-client's plain role"));
        passing = Some((tmp, new_admin.to_string()));
        c = t;
    }

    for (role, pw) in [(&visit, &visit_pw), (&auth, &auth_pw)] {
        match c.query_opt("SELECT rolsuper, oid = 10 FROM pg_roles WHERE rolname = $1", &[role]).await? {
            Some(r) if r.get::<_, bool>(1) => bail!("{role} is this database's bootstrap superuser, which stays one: give its URL as --admin"),
            Some(_) => {
                c.batch_execute(&format!("ALTER ROLE {} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {}", ident(role), lit(pw))).await?;
                out.push(format!("role {role}: plain, its password set"));
            }
            None => {
                c.batch_execute(&format!("CREATE ROLE {} LOGIN PASSWORD {}", ident(role), lit(pw))).await?;
                out.push(format!("role {role}: made"));
            }
        }
        c.batch_execute(&format!(
            "CREATE SCHEMA IF NOT EXISTS {r} AUTHORIZATION {r}; ALTER SCHEMA {r} OWNER TO {r}; REVOKE ALL ON SCHEMA {r} FROM PUBLIC;
             ALTER ROLE {r} SET search_path = {r}; GRANT CONNECT, TEMPORARY ON DATABASE {d} TO {r}", r = ident(role), d = ident(&db))).await?;
    }
    c.batch_execute(&format!("REVOKE ALL ON DATABASE {} FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC", ident(&db))).await?;

    for t in VISIT_TABLES {
        if c.query_one("SELECT to_regclass($1) IS NOT NULL", &[&format!("public.{t}")]).await?.get::<_, bool>(0) {
            c.batch_execute(&format!("ALTER TABLE public.{} SET SCHEMA {}", ident(t), ident(&visit))).await?;
            out.push(format!("visit-client's table {t}: moved into its schema"));
        }
    }
    for role in [&visit, &auth] {   // whatever is in a role's schema is its own
        for r in c.query("SELECT tablename::text FROM pg_tables WHERE schemaname = $1 AND tableowner <> $1", &[role]).await? {
            c.batch_execute(&format!("ALTER TABLE {}.{} OWNER TO {}", ident(role), ident(r.get::<_, &str>(0)), ident(role))).await?;
        }
    }

    if let Some((tmp, new_admin)) = passing {
        drop(c);
        connect(&new_admin).await?.batch_execute(&format!("DROP ROLE {}", ident(&tmp))).await.context("the role of the moment, dropped as the new superuser")?;
    }
    out.extend(migrate(auth_url, false).await?);
    Ok(out)
}

/// Tells every run that accounts, sessions or keys changed (they read them again).
pub async fn changed(c: &Client) -> Result<()> {
    c.batch_execute(&format!("NOTIFY {CHANGED}")).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_taken_apart_and_made() {
        let u = "postgres://visit:p%40ss%3Aword@127.0.0.1:7432/visit";
        assert_eq!(url_user(u).unwrap(), ("visit".into(), "p@ss:word".into()));
        assert_eq!(redact(u), "postgres://visit@127.0.0.1:7432/visit");
        let v = url_as(u, "auth", "a/b c").unwrap();
        assert_eq!(v, "postgres://auth:a%2Fb%20c@127.0.0.1:7432/visit");
        assert_eq!(url_user(&v).unwrap(), ("auth".into(), "a/b c".into()));
        assert!(url_user("visit@host").is_err());
        assert_eq!(ident("a\"b"), "\"a\"\"b\"");
        assert_eq!(lit("it's"), "'it''s'");
    }
}
