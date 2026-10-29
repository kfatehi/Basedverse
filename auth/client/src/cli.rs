//! The terminal's commands (../SPEC.md 2): accounts, sessions and API keys, straight in the database. Having a
//! terminal on the machine is the proof of ownership: there is no sign-up page, ever. What changes is told to the
//! running visit (NOTIFY), which reads it again at once.
use std::io::{BufRead, IsTerminal};

use anyhow::{bail, Context, Result};
use tokio_postgres::Client;

use crate::{db, secret};

/// A new password: typed twice in the terminal, without echo; or, `stdin`, one line from it (for a script).
fn new_password(name: &str, stdin: bool) -> Result<String> {
    let p = if stdin {
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line)?;
        line.trim_end_matches(['\r', '\n']).to_string()
    } else {
        if !std::io::stdin().is_terminal() {
            bail!("no terminal to type the password in: run it in one (or give it on stdin, with --password-stdin)");
        }
        let p = rpassword::prompt_password(format!("{name}'s password (at least {} characters): ", secret::MIN_PASSWORD))?;
        if let Some(why) = secret::password_rule(&p) {
            bail!(why);
        }
        if rpassword::prompt_password("Again: ")? != p {
            bail!("the two are not the same");
        }
        p
    };
    if let Some(why) = secret::password_rule(&p) {
        bail!(why);
    }
    Ok(p)
}

async fn user_id(c: &Client, name: &str) -> Result<i64> {
    match c.query_opt("SELECT id FROM auth.users WHERE lower(name) = lower($1)", &[&name]).await? {
        Some(r) => Ok(r.get(0)),
        None => bail!("no user {name}"),
    }
}

async fn hashed(p: String) -> Result<String> {
    tokio::task::spawn_blocking(move || secret::hash_password(&p)).await?
}

/// `user add <name>`.
pub async fn user_add(c: &Client, name: &str, stdin: bool) -> Result<()> {
    if !secret::name_ok(name) {
        bail!("{name:?}: a name is 1 to 64 letters, digits, . _ @ or -, starting with a letter or digit");
    }
    if c.query_opt("SELECT 1 FROM auth.users WHERE lower(name) = lower($1)", &[&name]).await?.is_some() {
        bail!("there is a user {name} already (a new password: visit auth passwd {name})");
    }
    let hash = hashed(new_password(name, stdin)?).await?;
    c.execute("INSERT INTO auth.users (name, password_hash) VALUES ($1, $2)", &[&name, &hash]).await?;
    println!("{name} can sign in now");
    Ok(())
}

/// `passwd <name>`: a new password, and the user's sessions ended (signed in anywhere, they sign in again).
pub async fn passwd(c: &Client, name: &str, stdin: bool) -> Result<()> {
    let id = user_id(c, name).await?;
    let hash = hashed(new_password(name, stdin)?).await?;
    c.execute("UPDATE auth.users SET password_hash = $2, password_changed_at = now() WHERE id = $1", &[&id, &hash]).await?;
    let n = c.execute("DELETE FROM auth.sessions WHERE user_id = $1", &[&id]).await?;
    db::changed(c).await?;
    println!("{name}'s password changed; {n} session{} ended", if n == 1 { "" } else { "s" });
    Ok(())
}

/// `user list`.
pub async fn user_list(c: &Client) -> Result<()> {
    let rows = c.query("SELECT u.name, to_char(u.created_at, 'YYYY-MM-DD HH24:MI TZ'), to_char(u.password_changed_at, 'YYYY-MM-DD HH24:MI TZ'),
                        (SELECT count(*) FROM auth.sessions s WHERE s.user_id = u.id AND s.expires_at > now())
                        FROM auth.users u ORDER BY u.created_at", &[]).await?;
    if rows.is_empty() {
        println!("no users yet: visit auth user add <name>");
        return Ok(());
    }
    table(&["USER", "MADE", "PASSWORD CHANGED", "SESSIONS"], rows.iter().map(|r| vec![r.get(0), r.get(1), r.get(2), r.get::<_, i64>(3).to_string()]).collect());
    Ok(())
}

/// `user remove <name>`: the account, and its sessions with it.
pub async fn user_remove(c: &Client, name: &str) -> Result<()> {
    let id = user_id(c, name).await?;
    c.execute("DELETE FROM auth.users WHERE id = $1", &[&id]).await?;
    db::changed(c).await?;
    println!("{name} removed, and signed out everywhere");
    Ok(())
}

/// `sessions [<name>]`: the signed-in sessions (by the start of their id's hash: the id itself is never kept), and
/// the last sign-ins tried.
pub async fn sessions(c: &Client, name: Option<&str>) -> Result<()> {
    let rows = c.query("SELECT left(encode(s.id_hash, 'hex'), 10), u.name, to_char(s.created_at, 'YYYY-MM-DD HH24:MI'), to_char(s.last_seen_at, 'YYYY-MM-DD HH24:MI'),
                        COALESCE(s.client_address, '-'), to_char(s.expires_at, 'YYYY-MM-DD HH24:MI'), COALESCE(left(s.user_agent, 40), '-')
                        FROM auth.sessions s JOIN auth.users u ON u.id = s.user_id
                        WHERE s.expires_at > now() AND ($1::text IS NULL OR lower(u.name) = lower($1)) ORDER BY s.last_seen_at DESC", &[&name]).await?;
    if rows.is_empty() {
        println!("no one is signed in{}", name.map(|n| format!(" as {n}")).unwrap_or_default());
    } else {
        table(&["SESSION", "USER", "SINCE", "LAST SEEN", "FROM", "ENDS BY", "BROWSER"], rows.iter().map(|r| (0..7).map(|i| r.get::<_, String>(i)).collect()).collect());
    }
    let tries = c.query("SELECT to_char(at, 'YYYY-MM-DD HH24:MI:SS'), user_name, COALESCE(client_address, '-'), CASE WHEN ok THEN 'signed in' WHEN waited THEN 'too soon' ELSE 'wrong' END
                         FROM auth.login_attempts WHERE ($1::text IS NULL OR lower(user_name) = lower($1)) ORDER BY at DESC LIMIT 10", &[&name]).await?;
    if !tries.is_empty() {
        println!("\nthe last sign-ins tried (times {}):", c.query_one("SELECT current_setting('TimeZone')", &[]).await?.get::<_, String>(0));
        table(&["AT", "AS", "FROM", ""], tries.iter().map(|r| (0..4).map(|i| r.get::<_, String>(i)).collect()).collect());
    }
    Ok(())
}

/// `revoke <session>` (the start of its hash, as `sessions` shows it) or `revoke --user <name>`.
pub async fn revoke(c: &Client, session: Option<&str>, user: Option<&str>) -> Result<()> {
    let n = match (session, user) {
        (Some(p), None) => {
            let p = p.to_ascii_lowercase();
            if p.len() < 6 || !p.chars().all(|c| c.is_ascii_hexdigit()) {
                bail!("a session, as visit auth sessions shows it (its first 6 hex characters at least)");
            }
            let hits = c.query("SELECT id_hash FROM auth.sessions WHERE encode(id_hash, 'hex') LIKE $1 || '%'", &[&p]).await?;
            if hits.len() > 1 {
                bail!("{p} is the start of {} sessions: give more of it", hits.len());
            }
            let Some(h) = hits.first() else { bail!("no session {p}") };
            c.execute("DELETE FROM auth.sessions WHERE id_hash = $1", &[&h.get::<_, Vec<u8>>(0)]).await?
        }
        (None, Some(name)) => {
            let id = user_id(c, name).await?;
            c.execute("DELETE FROM auth.sessions WHERE user_id = $1", &[&id]).await?
        }
        _ => bail!("revoke <session> or revoke --user <name>"),
    };
    db::changed(c).await?;
    println!("{n} session{} ended", if n == 1 { "" } else { "s" });
    Ok(())
}

/// `key add <label>`: a key for a script or an agent, printed once (only its hash is kept).
pub async fn key_add(c: &Client, label: &str) -> Result<()> {
    if !secret::name_ok(label) {
        bail!("{label:?}: a label is 1 to 64 letters, digits, . _ @ or -, starting with a letter or digit");
    }
    let key = secret::api_key();
    c.execute("INSERT INTO auth.api_keys (label, key_hash) VALUES ($1, $2)", &[&label, &secret::digest(&key)]).await
        .with_context(|| format!("a key labelled {label} is there already (visit auth key revoke {label}, first)"))?;
    db::changed(c).await?;
    if std::io::stdout().is_terminal() {
        eprintln!("{label}'s key: it is shown this once. Send it as Authorization: Bearer <key>.");
    }
    println!("{key}");
    Ok(())
}

/// `key list`.
pub async fn key_list(c: &Client) -> Result<()> {
    let rows = c.query("SELECT label, to_char(created_at, 'YYYY-MM-DD HH24:MI'), COALESCE(to_char(last_used_at, 'YYYY-MM-DD HH24:MI'), 'never'),
                        COALESCE('revoked ' || to_char(revoked_at, 'YYYY-MM-DD HH24:MI'), 'live') FROM auth.api_keys ORDER BY revoked_at IS NOT NULL, created_at", &[]).await?;
    if rows.is_empty() {
        println!("no keys yet: visit auth key add <label>");
        return Ok(());
    }
    table(&["KEY", "MADE", "LAST USED", ""], rows.iter().map(|r| (0..4).map(|i| r.get::<_, String>(i)).collect()).collect());
    Ok(())
}

/// `key revoke <label>`.
pub async fn key_revoke(c: &Client, label: &str) -> Result<()> {
    if c.execute("UPDATE auth.api_keys SET revoked_at = now() WHERE label = $1 AND revoked_at IS NULL", &[&label]).await? == 0 {
        bail!("no live key {label}");
    }
    db::changed(c).await?;
    println!("{label}'s key revoked");
    Ok(())
}

/// Rows under their heads, in columns.
fn table(heads: &[&str], rows: Vec<Vec<String>>) {
    let w: Vec<usize> = (0..heads.len()).map(|i| rows.iter().map(|r| r[i].chars().count()).chain([heads[i].len()]).max().unwrap_or(0)).collect();
    let line = |cells: Vec<&str>| cells.iter().enumerate().map(|(i, c)| format!("{c:<w$}", w = w[i])).collect::<Vec<_>>().join("  ").trim_end().to_string();
    println!("{}", line(heads.to_vec()));
    for r in &rows {
        println!("{}", line(r.iter().map(String::as_str).collect()));
    }
}
