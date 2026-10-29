//! What visit carries inside it (../../V2.md 3): the Postgres and the Chrome its build put in (build.rs, from
//! ../../deps/pinned.json), unpacked once per version into the user's runtime directory, shared by all their
//! workrooms, and where a workroom keeps its own data.
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};

/// One of the programs inside visit: its archive's name (without `.tar.gz`, the directory it unpacks to), its
/// sha256, its version as deps/ names it, and its bytes.
pub struct Inside {
    pub name: &'static str,
    pub sha256: &'static str,
    pub version: &'static str,
    pub bytes: &'static [u8],
}

pub static POSTGRES: Inside = Inside {
    name: env!("VISIT_POSTGRES_NAME"),
    sha256: env!("VISIT_POSTGRES_SHA256"),
    version: env!("VISIT_POSTGRES_VERSION"),
    bytes: include_bytes!(env!("VISIT_POSTGRES_ARCHIVE")),
};

/// The user's data folder: `$XDG_DATA_HOME` or `~/.local/share` on Linux, `~/Library/Application Support` on
/// macOS, `%LOCALAPPDATA%` on Windows; then `basedverse` in it.
pub fn basedverse_dir() -> Result<PathBuf> {
    let env = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    let base = if cfg!(windows) {
        env("LOCALAPPDATA").context("%LOCALAPPDATA% is not set")?
    } else if cfg!(target_os = "macos") {
        env("HOME").context("$HOME is not set")?.join("Library/Application Support")
    } else {
        match env("XDG_DATA_HOME") {
            Some(d) => d,
            None => env("HOME").context("$HOME is not set")?.join(".local/share"),
        }
    };
    Ok(base.join("basedverse"))
}

/// A workroom's data directory when VISIT_DATA_DIR doesn't say: `basedverse/<its name>`, the name made a folder's
/// (letters and digits kept, lower case; anything else a `-`).
pub fn default_data_dir(name: &str) -> Result<PathBuf> {
    let mut folder: String = name.trim().chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    folder = folder.trim_matches('-').to_string();
    if folder.is_empty() {
        bail!("no folder can be made of the workroom's name {name:?}: give VISIT_DATA_DIR");
    }
    Ok(basedverse_dir()?.join(folder))
}

/// Where `inside` is, unpacked: `basedverse/runtime/<its name>`, unpacked now if it isn't there whole (a
/// `.visit-sha256` written last, naming the archive it came from). Two visits starting at once each unpack into
/// a directory of their own and the first rename wins.
pub fn unpacked(inside: &Inside) -> Result<PathBuf> {
    let root = basedverse_dir()?.join("runtime");
    let dir = root.join(inside.name);
    let mark = dir.join(".visit-sha256");
    if fs::read_to_string(&mark).is_ok_and(|s| s.trim() == inside.sha256) {
        return Ok(dir);
    }
    fs::create_dir_all(&root).with_context(|| format!("making {}", root.display()))?;
    let got = hex(&Sha256::digest(inside.bytes));
    if got != inside.sha256 {
        bail!("{} inside this visit is not the one it was built with (sha256 {got}): download visit again", inside.name);
    }
    let tmp = root.join(format!(".{}.{}", inside.name, std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    unpack(inside.bytes, &tmp).with_context(|| format!("unpacking {} into {}", inside.name, tmp.display()))?;
    fs::write(tmp.join(".visit-sha256"), inside.sha256)?;
    if dir.exists() {
        let _ = fs::remove_dir_all(&dir);   // half there (no mark, or another one's): ours replaces it
    }
    if let Err(e) = fs::rename(&tmp, &dir) {
        let _ = fs::remove_dir_all(&tmp);
        if !fs::read_to_string(&mark).is_ok_and(|s| s.trim() == inside.sha256) {
            return Err(e).with_context(|| format!("moving {} into place", inside.name));
        }
    }
    Ok(dir)
}

/// A .tar.gz with one top directory, unpacked into `into` without it (its files keep their modes; a hard link in
/// it, as Postgres' time zones have, made to the file it names there, or a copy of it where links can't be made).
fn unpack(bytes: &[u8], into: &Path) -> Result<()> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
    archive.set_preserve_permissions(true);
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        let Some(rest) = inside_top(&path)? else { continue };
        let to = into.join(&rest);
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        if entry.header().entry_type().is_hard_link() {
            let target = entry.link_name()?.with_context(|| format!("{}: a link to nothing", path.display()))?.into_owned();
            let from = into.join(inside_top(&target)?.with_context(|| format!("{}: a link to the top", path.display()))?);
            if fs::hard_link(&from, &to).is_err() {
                fs::copy(&from, &to)?;
            }
            continue;
        }
        entry.unpack(&to)?;
    }
    Ok(())
}

/// An archive's path without its top directory (None: the top itself); refused if it reaches outside it.
fn inside_top(path: &Path) -> Result<Option<PathBuf>> {
    let mut parts = path.components();
    parts.next();
    let rest = parts.as_path();
    if rest.as_os_str().is_empty() {
        return Ok(None);
    }
    if rest.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
        bail!("{} reaches outside its directory", path.display());
    }
    Ok(Some(rest.to_path_buf()))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_workrooms_folder_from_its_name() {
        std::env::set_var("XDG_DATA_HOME", "/data");
        std::env::set_var("HOME", "/home/x");
        if cfg!(target_os = "linux") {
            assert_eq!(default_data_dir("Terrorist Sweatshop").unwrap(), PathBuf::from("/data/basedverse/terrorist-sweatshop"));
            assert_eq!(default_data_dir(" aldo.s room ").unwrap(), PathBuf::from("/data/basedverse/aldo-s-room"));
        }
        assert!(default_data_dir("...").is_err());
    }

    #[test]
    fn the_postgres_inside_is_the_pinned_one() {
        assert_eq!(hex(&Sha256::digest(POSTGRES.bytes)), POSTGRES.sha256);
    }
}
