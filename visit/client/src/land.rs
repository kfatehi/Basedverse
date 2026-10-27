//! Landscapes (../SPEC.md 8.10): the part of a room its page marks as never changing, sent once and kept here by
//! the office whose room it is and the hash of what it is (blake3, hex), so a visit or watch that starts again
//! needs only the rest. And the friends whose plots were in this office's world, each with where its plot is: its
//! last landscape is drawn there while they are away, until they say otherwise. On disk (a directory of its own)
//! when there is one, else for this run only.

use std::path::{Path, PathBuf};

use bytes::Bytes;
use serde_json::{json, Value};
use tracing::warn;

use crate::state::{clip_name, key_ok};

/// The most kept on disk (the oldest go first), and in memory without a disk.
const DISK_BYTES: u64 = 256 << 20;
const MEMORY_BYTES: usize = 128 << 20;
/// The most friends' plots kept to draw while they are away.
const MAX_KEPT: usize = 64;

/// A friend's plot kept to draw while they are away: who, and where its plot is in its own terms (its middle and
/// size, in its units, and the metres of a unit).
#[derive(Clone, Debug, PartialEq)]
pub struct Kept {
    pub key: String,
    pub name: String,
    pub center: [f64; 2],
    pub size: [f64; 2],
    pub unit: f64,
}

impl Kept {
    pub fn from_json(v: &Value) -> Option<Kept> {
        let key = v.get("key").and_then(Value::as_str).filter(|k| key_ok(k))?.to_string();
        let n = |x: &Value, lo: f64| x.as_f64().filter(|x| x.is_finite() && x.abs() <= 1e5 && *x >= lo);
        let pair = |x: Option<&Value>, lo: f64| -> Option<[f64; 2]> {
            let a = x?.as_array().filter(|a| a.len() == 2)?;
            Some([n(&a[0], lo)?, n(&a[1], lo)?])
        };
        let plot = v.get("plot")?;
        let size = pair(plot.get("size"), 1e-3)?;
        Some(Kept {
            key, name: clip_name(v.get("name").and_then(Value::as_str).unwrap_or("")),
            center: pair(plot.get("center"), -1e5)?, size,
            unit: v.get("unit").and_then(Value::as_f64).filter(|u| u.is_finite() && *u > 0.0 && *u <= 1000.0).unwrap_or(1.0),
        })
    }

    pub fn to_json(&self) -> Value {
        json!({ "key": self.key, "name": self.name, "plot": { "center": self.center, "size": self.size }, "unit": self.unit })
    }
}

pub struct Lands {
    dir: Option<PathBuf>,
    /// Without a disk: (office key, hash, landscape), the newest last.
    memory: Vec<(String, String, Bytes)>,
    kept: Vec<Kept>,
}

/// A landscape's name: the blake3 hash of what it is (its gzipped JSON), hex.
pub fn hash(gz: &[u8]) -> String {
    blake3::hash(gz).to_hex().to_string()
}

/// A hash as this office writes them: 64 hex digits, lower case.
pub fn hash_ok(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl Lands {
    pub fn open(dir: Option<PathBuf>) -> Lands {
        let dir = dir.filter(|d| match std::fs::create_dir_all(d) {
            Ok(()) => true,
            Err(e) => { warn!(dir = %d.display(), "landscapes kept for this run only: {e}"); false }
        });
        let mut lands = Lands { dir, memory: Vec::new(), kept: Vec::new() };
        if let Some(d) = &lands.dir {
            let v: Value = std::fs::read_to_string(d.join("kept.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
            lands.kept = v.as_array().into_iter().flatten().filter_map(Kept::from_json).take(MAX_KEPT).collect();
        }
        lands
    }

    fn office_dir(&self, key: &str) -> Option<PathBuf> {
        self.dir.as_ref().filter(|_| key_ok(key)).map(|d| d.join(key))
    }

    /// The landscape this office has of that one, by its hash.
    pub fn get(&self, key: &str, hash: &str) -> Option<Bytes> {
        if !hash_ok(hash) {
            return None;
        }
        if let Some(d) = self.office_dir(key) {
            return std::fs::read(d.join(format!("{hash}.gz"))).ok().map(Bytes::from);
        }
        self.memory.iter().find(|(k, h, _)| k == key && h == hash).map(|(_, _, gz)| gz.clone())
    }

    /// The last landscape kept of that office, whichever it is.
    pub fn latest(&self, key: &str) -> Option<Bytes> {
        if let Some(d) = self.office_dir(key) {
            let file = std::fs::read_dir(&d).ok()?.flatten().map(|e| e.path()).find(|p| p.extension().is_some_and(|x| x == "gz"))?;
            return std::fs::read(file).ok().map(Bytes::from);
        }
        self.memory.iter().rev().find(|(k, _, _)| k == key).map(|(_, _, gz)| gz.clone())
    }

    /// Kept, in place of any other of that office's: on disk (written beside it, then renamed), the oldest of all
    /// let go past DISK_BYTES.
    pub fn put(&mut self, key: &str, hash: &str, gz: &Bytes) {
        if !hash_ok(hash) || !key_ok(key) {
            return;
        }
        if let Some(d) = self.office_dir(key) {
            let written = (|| -> std::io::Result<()> {
                std::fs::create_dir_all(&d)?;
                let tmp = d.join(format!("{hash}.tmp"));
                std::fs::write(&tmp, gz)?;
                std::fs::rename(&tmp, d.join(format!("{hash}.gz")))?;
                for e in std::fs::read_dir(&d)?.flatten() {
                    if e.file_name().to_string_lossy() != format!("{hash}.gz") {
                        let _ = std::fs::remove_file(e.path());
                    }
                }
                Ok(())
            })();
            if let Err(e) = written {
                warn!(dir = %d.display(), "a landscape could not be kept: {e}");
            }
            if let Some(root) = self.dir.clone() {
                trim(&root, DISK_BYTES);
            }
            return;
        }
        self.memory.retain(|(k, _, _)| k != key);
        self.memory.push((key.to_string(), hash.to_string(), gz.clone()));
        while self.memory.iter().map(|(_, _, g)| g.len()).sum::<usize>() > MEMORY_BYTES && self.memory.len() > 1 {
            self.memory.remove(0);
        }
    }

    /// That office's landscape and plot, let go: it said so, or this office no longer has it as a friend. True if
    /// there was a plot kept to draw while they are away.
    pub fn forget(&mut self, key: &str) -> bool {
        self.memory.retain(|(k, _, _)| k != key);
        if let Some(d) = self.office_dir(key) {
            let _ = std::fs::remove_dir_all(d);
        }
        let had = self.kept.iter().any(|a| a.key == key);
        if had {
            self.kept.retain(|a| a.key != key);
            self.save_kept();
        }
        had
    }

    /// A friend's plot to draw while they are away (in place of what was kept of it): at most MAX_KEPT, the oldest
    /// let go.
    pub fn keep_plot(&mut self, a: Kept) {
        if self.kept.iter().any(|x| *x == a) {
            return;
        }
        self.kept.retain(|x| x.key != a.key);
        self.kept.push(a);
        while self.kept.len() > MAX_KEPT {
            let gone = self.kept.remove(0);
            self.memory.retain(|(k, _, _)| *k != gone.key);
            if let Some(d) = self.office_dir(&gone.key) {
                let _ = std::fs::remove_dir_all(d);
            }
        }
        self.save_kept();
    }

    /// The plots kept to draw while their offices are away: those with a landscape kept.
    pub fn kept_json(&self) -> Vec<Value> {
        self.kept.iter().filter(|a| self.latest(&a.key).is_some()).map(Kept::to_json).collect()
    }

    pub fn is_kept(&self, key: &str) -> bool {
        self.kept.iter().any(|a| a.key == key)
    }

    fn save_kept(&self) {
        let Some(d) = &self.dir else { return };
        let body = Value::Array(self.kept.iter().map(Kept::to_json).collect()).to_string();
        let tmp = d.join("kept.tmp");
        if let Err(e) = std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, d.join("kept.json"))) {
            warn!(dir = %d.display(), "the plots kept for while their offices are away could not be written: {e}");
        }
    }
}

/// The oldest landscapes under `root` let go until all of them take at most `cap` bytes.
fn trim(root: &Path, cap: u64) {
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = std::fs::read_dir(root).into_iter().flatten().flatten()
        .filter(|e| e.path().is_dir())
        .flat_map(|d| std::fs::read_dir(d.path()).into_iter().flatten().flatten())
        .filter_map(|f| { let m = f.metadata().ok()?; Some((m.modified().ok()?, m.len(), f.path())) })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.0);
    for (_, len, path) in files {
        if total <= cap {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iroh::SecretKey;

    #[test]
    fn landscapes_are_kept_by_office_and_hash_and_let_go() {
        let dir = std::env::temp_dir().join(format!("visit-lands-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (k1, k2) = (SecretKey::generate().public().to_string(), SecretKey::generate().public().to_string());
        let (a, b) = (Bytes::from_static(b"landscape one"), Bytes::from_static(b"landscape two"));
        let (ha, hb) = (hash(&a), hash(&b));
        assert!(hash_ok(&ha) && ha != hb && !hash_ok("../x") && !hash_ok(&ha.to_uppercase()));
        let mut l = Lands::open(Some(dir.clone()));
        l.put(&k1, &ha, &a);
        assert_eq!((l.get(&k1, &ha), l.get(&k2, &ha), l.get(&k1, &hb)), (Some(a.clone()), None, None), "only by the office that sent it");
        l.put(&k1, &hb, &b);
        assert_eq!((l.get(&k1, &ha), l.latest(&k1)), (None, Some(b.clone())), "one kept per office: the newest");
        let plot = Kept { key: k1.clone(), name: "Ada".into(), center: [5.0, 4.0], size: [10.0, 8.0], unit: 1.0 };
        l.keep_plot(plot.clone());
        let again = Lands::open(Some(dir.clone()));
        assert_eq!(again.kept_json(), vec![plot.to_json()], "kept across runs");
        assert_eq!(Kept::from_json(&plot.to_json()), Some(plot));
        let mut l = again;
        assert!(l.forget(&k1) && l.latest(&k1).is_none() && l.kept_json().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
        let mut m = Lands::open(None);
        m.put(&k2, &ha, &a);
        assert_eq!(m.get(&k2, &ha), Some(a));
    }

    #[test]
    fn the_oldest_go_past_the_cap() {
        let dir = std::env::temp_dir().join(format!("visit-trim-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for (i, name) in ["a", "b", "c"].iter().enumerate() {
            std::fs::create_dir_all(dir.join(name)).unwrap();
            std::fs::write(dir.join(name).join("x.gz"), vec![0u8; 100]).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20 * (i as u64 + 1)));
        }
        trim(&dir, 200);
        assert_eq!(["a", "b", "c"].map(|n| dir.join(n).join("x.gz").exists()), [false, true, true]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
