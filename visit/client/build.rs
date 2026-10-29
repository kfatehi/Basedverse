//! Builds the pinned Postgres (and, from V2.md step 4, Chrome) into visit (../../V2.md 6.2). For the platform being
//! built, the archive ../../deps/pinned.json names is taken from ../../deps/dist/ when a file of that name there has
//! the pinned sha256 (what deps/<…>/build made, pinned with `deps/pin --local`), else downloaded from its URL once
//! into this build's output directory; checked against the sha256 either way. src/runtime.rs includes it.
use std::{env, fs, path::PathBuf};

use sha2::{Digest, Sha256};

fn main() {
    let repo = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let pinned_path = repo.join("deps/pinned.json");
    println!("cargo:rerun-if-changed={}", pinned_path.display());
    let platform = match (env::var("CARGO_CFG_TARGET_OS").unwrap().as_str(), env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str()) {
        ("linux", "x86_64") => "linux-x86_64",
        ("linux", "aarch64") => "linux-aarch64",
        ("macos", "aarch64") => "macos-aarch64",
        ("macos", "x86_64") => "macos-x86_64",
        ("windows", "x86_64") => "windows-x86_64",
        (os, arch) => panic!("visit is built for Linux x86_64/arm64, macOS and Windows x86_64, not {os} {arch}"),
    };
    let pinned: serde_json::Value = serde_json::from_str(&fs::read_to_string(&pinned_path)
        .unwrap_or_else(|e| panic!("{}: {e} (deps/pin writes it)", pinned_path.display())))
        .expect("deps/pinned.json is JSON");
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    for (dep, var) in [("postgres", "POSTGRES")] {
        let d = &pinned[dep];
        let f = &d["files"][platform];
        let (name, url, sha) = (f["name"].as_str(), f["url"].as_str(), f["sha256"].as_str());
        let (Some(name), Some(url), Some(sha)) = (name, url, sha) else {
            panic!("deps/pinned.json has no {dep} for {platform}")
        };
        let local = repo.join("deps/dist").join(name);
        println!("cargo:rerun-if-changed={}", local.display());
        let path = if local.is_file() && sha256(&fs::read(&local).unwrap()) == sha {
            local
        } else {
            let to = out.join(name);
            if !(to.is_file() && sha256(&fs::read(&to).unwrap()) == sha) {
                let bytes = fetch(url);
                let got = sha256(&bytes);
                assert_eq!(got, sha, "{url}: sha256 {got}, pinned {sha}");
                fs::write(&to, &bytes).unwrap();
            }
            to
        };
        println!("cargo:rustc-env=VISIT_{var}_ARCHIVE={}", path.canonicalize().unwrap().display());
        println!("cargo:rustc-env=VISIT_{var}_NAME={}", name.trim_end_matches(".tar.gz"));
        println!("cargo:rustc-env=VISIT_{var}_SHA256={sha}");
        println!("cargo:rustc-env=VISIT_{var}_VERSION={}-{}", d["version"].as_str().unwrap_or("?"), d["build"]);
    }
}

fn sha256(b: &[u8]) -> String {
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

fn fetch(url: &str) -> Vec<u8> {
    if let Some(path) = url.strip_prefix("file://") {
        return fs::read(path).unwrap_or_else(|e| panic!("{url}: {e}"));
    }
    let mut res = ureq::get(url).call().unwrap_or_else(|e| panic!("{url}: {e}"));
    res.body_mut().with_config().limit(1 << 30).read_to_vec().unwrap_or_else(|e| panic!("{url}: {e}"))
}
