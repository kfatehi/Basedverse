//! What a visit-client keeps across its runs, in its state file (`--state-file`, ../SPEC.md section 4.1):
//! whether its office is out of the lobby, its link key (the office's lasting identity, and its secret half:
//! the file is readable by its owner only), its door and its guests. Written whole each time, by a rename.
use std::{io::Write, path::Path};

use iroh::{EndpointId, SecretKey};
use serde_json::{json, Value};

/// The most guests an office keeps.
pub const MAX_GUESTS: usize = 256;

/// Someone let in without knocking while the door is open: their key, and the name they were known by.
#[derive(Clone, Debug, PartialEq)]
pub struct Guest {
    pub key: String,
    pub name: String,
}

pub struct Saved {
    pub away: bool,
    pub key: SecretKey,
    pub door_open: bool,
    pub guests: Vec<Guest>,
}

impl Saved {
    /// What the file says, and for anything it lacks (or no file at all) the defaults: in the lobby, a new
    /// key, the door open, no guests. With it, whether it lacked a key: then it should be written, to keep the
    /// one made now.
    pub fn load(path: Option<&Path>) -> (Saved, bool) {
        let v: Value = path.and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
        let key = v.get("key").and_then(Value::as_str).and_then(unhex32).map(|b| SecretKey::from_bytes(&b));
        let fresh = key.is_none();
        let guests = v.get("guests").and_then(Value::as_array).into_iter().flatten()
            .filter_map(|g| {
                let key = g.get("key").and_then(Value::as_str).filter(|k| key_ok(k))?;
                Some(Guest { key: key.to_string(), name: clip_name(g.get("name").and_then(Value::as_str).unwrap_or("")) })
            })
            .take(MAX_GUESTS)
            .collect();
        let saved = Saved {
            away: v.get("away").and_then(Value::as_bool).unwrap_or(false),
            key: key.unwrap_or_else(SecretKey::generate),
            door_open: v.get("door").and_then(Value::as_str) != Some("closed"),
            guests,
        };
        (saved, fresh)
    }

    pub fn to_json(&self) -> Value {
        json!({
            "away": self.away, "key": hex(&self.key.to_bytes()), "door": if self.door_open { "open" } else { "closed" },
            "guests": self.guests.iter().map(|g| json!({ "key": g.key, "name": g.name })).collect::<Vec<_>>(),
        })
    }

    /// Written to a file beside it, readable by its owner only, then renamed over it.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let tmp = path.with_extension("tmp");
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        let mut f = opts.open(&tmp)?;
        f.write_all(self.to_json().to_string().as_bytes())?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    }
}

/// An office's key, as the lobby lists it: a link endpoint's public key.
pub fn key_ok(k: &str) -> bool {
    k.len() <= 100 && k.parse::<EndpointId>().is_ok()
}

/// A guest's name, as a page or the lobby gave it: at most 24 characters, none of them a control character.
pub fn clip_name(n: &str) -> String {
    n.chars().filter(|c| !c.is_control()).take(24).collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex32(s: &str) -> Option<[u8; 32]> {
    let b = s.as_bytes();
    if b.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, pair) in b.chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_is_kept_across_runs() {
        let dir = std::env::temp_dir().join(format!("visit-state-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        let _ = std::fs::remove_file(&path);
        let (first, fresh) = Saved::load(Some(&path));
        assert!(fresh && !first.away && first.door_open && first.guests.is_empty());
        let mut s = first;
        s.door_open = false;
        s.guests.push(Guest { key: SecretKey::generate().public().to_string(), name: "Ada".into() });
        s.save(&path).unwrap();
        let (again, fresh) = Saved::load(Some(&path));
        assert!(!fresh);
        assert_eq!((again.key.public(), again.door_open, again.guests.clone()), (s.key.public(), false, s.guests.clone()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_old_file_or_none_gets_the_defaults() {
        let (s, fresh) = Saved::load(None);
        assert!(fresh && !s.away && s.door_open);
        let dir = std::env::temp_dir().join(format!("visit-state-old-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        std::fs::write(&path, r#"{"away": true, "guests": [{"key": "not a key", "name": "x"}]}"#).unwrap();
        let (s, fresh) = Saved::load(Some(&path));
        assert!(fresh && s.away && s.guests.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keys_and_names() {
        assert!(key_ok(&SecretKey::generate().public().to_string()));
        assert!(!key_ok("") && !key_ok("o1a2b3c4") && !key_ok(&"z".repeat(64)));
        assert_eq!(clip_name("Ada\n Lovelace and a very long name indeed"), "Ada Lovelace and a very ");
        assert_eq!(unhex32(&hex(&[7u8; 32])), Some([7u8; 32]));
        assert_eq!(unhex32("abc"), None);
    }
}
