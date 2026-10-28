//! Secrets (../SPEC.md 4): session ids and API keys from the OS's secure generator, kept by their SHA-256 only;
//! passwords hashed with Argon2id; and the rules for names, labels and passwords.
use std::time::Duration;

use anyhow::{anyhow, Result};
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};

/// Argon2id at OWASP's parameters: 19 MiB, 2 passes, 1 lane. A hash keeps its own, so raising them later
/// leaves the old ones readable.
const MEMORY_KIB: u32 = 19 * 1024;
const PASSES: u32 = 2;
const LANES: u32 = 1;
/// A password: at least this many characters, and no other rule on what they are (NIST SP 800-63B).
pub const MIN_PASSWORD: usize = 12;
/// ...and at most this many bytes, so a hash is never asked to read a megabyte.
pub const MAX_PASSWORD: usize = 1024;

fn argon2() -> Argon2<'static> {
    Argon2::new(Algorithm::Argon2id, Version::V0x13, Params::new(MEMORY_KIB, PASSES, LANES, None).expect("Argon2's parameters"))
}

/// `n` bytes from the OS's secure generator.
pub fn random(n: usize) -> Vec<u8> {
    let mut b = vec![0; n];
    getrandom::fill(&mut b).expect("the OS's secure random generator");
    b
}

/// Bytes as lowercase hex.
pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// A new session id: 32 random bytes, base64url.
pub fn session_id() -> String {
    URL_SAFE_NO_PAD.encode(random(32))
}

/// A new API key: `bvk_` and 32 random bytes, base64url (the prefix says what it is, to a scan for leaked keys).
pub fn api_key() -> String {
    format!("bvk_{}", URL_SAFE_NO_PAD.encode(random(32)))
}

/// What is kept of a session id or an API key: its SHA-256.
pub fn digest(secret: &str) -> Vec<u8> {
    Sha256::digest(secret.as_bytes()).to_vec()
}

/// Why a password will not do, if it will not.
pub fn password_rule(p: &str) -> Option<String> {
    if p.chars().count() < MIN_PASSWORD {
        return Some(format!("a password is at least {MIN_PASSWORD} characters"));
    }
    (p.len() > MAX_PASSWORD).then(|| format!("a password is at most {MAX_PASSWORD} bytes"))
}

/// A password's Argon2id hash, with a salt of its own (the PHC string: its parameters and salt in it).
pub fn hash_password(p: &str) -> Result<String> {
    let salt = SaltString::encode_b64(&random(16)).map_err(|e| anyhow!("a salt: {e}"))?;
    Ok(argon2().hash_password(p.as_bytes(), &salt).map_err(|e| anyhow!("hashing a password: {e}"))?.to_string())
}

/// Whether a password is the one a hash was made from (by the hash's own parameters).
pub fn password_matches(p: &str, hash: &str) -> bool {
    p.len() <= MAX_PASSWORD && PasswordHash::new(hash).is_ok_and(|h| argon2().verify_password(p.as_bytes(), &h).is_ok())
}

/// A user's name or a key's label: 1 to 64 letters, digits, `.`, `_`, `@` or `-`, starting with a letter or digit.
pub fn name_ok(n: &str) -> bool {
    (1..=64).contains(&n.len())
        && n.starts_with(|c: char| c.is_ascii_alphanumeric())
        && n.chars().all(|c| c.is_ascii_alphanumeric() || "._@-".contains(c))
}

/// A time as the flags give it: a number and s, m, h or d (`7d`, `30d`, `90s`).
pub fn duration(s: &str) -> Result<Duration, String> {
    let bad = || format!("{s:?}: a number and s, m, h or d (7d, 30d, 90s)");
    let t = s.trim();
    let (n, unit) = t.split_at(t.char_indices().last().ok_or_else(bad)?.0);
    let n: u64 = n.parse().map_err(|_| bad())?;
    let secs = match unit {
        "s" => n,
        "m" => n * 60,
        "h" => n * 3600,
        "d" => n * 86400,
        _ => return Err(bad()),
    };
    if secs == 0 {
        return Err(format!("{s:?}: more than nothing"));
    }
    Ok(Duration::from_secs(secs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_long_random_and_kept_by_their_digest() {
        let (a, b) = (session_id(), session_id());
        assert_eq!(a.len(), 43);   // 32 bytes, base64url without padding
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        let k = api_key();
        assert!(k.starts_with("bvk_") && k.len() == 47);
        assert_eq!(digest(&a).len(), 32);
        assert_eq!(digest(&a), digest(&a));
        assert_eq!(hex(&digest("abc"))[..16], *"ba7816bf8f01cfea");   // SHA-256, as everyone has it
    }

    #[test]
    fn a_password_hashed_and_checked() {
        assert_eq!(password_rule("short"), Some("a password is at least 12 characters".into()));
        assert_eq!(password_rule("twelve chars"), None);
        assert!(password_rule(&"x".repeat(MAX_PASSWORD + 1)).is_some());
        let h = hash_password("correct horse battery").unwrap();
        assert!(h.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"));
        assert!(password_matches("correct horse battery", &h));
        assert!(!password_matches("correct horse batterY", &h));
        assert!(!password_matches("anything", "not a hash"));
        assert_ne!(h, hash_password("correct horse battery").unwrap());   // a salt of its own
    }

    #[test]
    fn names_and_times() {
        assert!(name_ok("aldo") && name_ok("thinger.burgoon") && name_ok("ci-bot_2"));
        assert!(!name_ok("") && !name_ok("-x") && !name_ok("a b") && !name_ok(&"a".repeat(65)) && !name_ok("ünï"));
        assert_eq!(duration("7d"), Ok(Duration::from_secs(7 * 86400)));
        assert_eq!(duration("90s"), Ok(Duration::from_secs(90)));
        assert!(duration("7").is_err() && duration("0d").is_err() && duration("d").is_err() && duration("7w").is_err() && duration("7é").is_err());
    }
}
