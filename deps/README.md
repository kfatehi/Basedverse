# deps

What is built into `visit` besides its own code (V2.md, #22): **Postgres** and a **headless Chrome**, for each
platform, with everything they need. Nobody installs them and `visit` downloads nothing: its build takes the
archives `deps/pinned.json` names, checks each against its sha256 and carries them inside; on first start it
unpacks them and runs them as its own children. This directory makes those archives, and is how either is
upgraded.

Docker is used here and in CI to build and test; nothing that runs `visit` needs it.

## What is inside, and where it comes from

| platform | Postgres 18.6 | Chrome (headless shell 156.0.8078.73) |
|---|---|---|
| `linux-x86_64`, `linux-aarch64` | compiled from the official source in manylinux_2_28 (glibc 2.28), only the C library under it; ~7 MB | Chrome for Testing's, with the 61 libraries it needs from AlmaLinux 8 (glibc 2.28) and DejaVu fonts packed beside it; ~122 MB |
| `macos-aarch64`, `macos-x86_64` | compiled from the official source on a Mac, relocatable (`@rpath`), signed ad hoc; the Intel one cross-compiled | Chrome for Testing's, untouched (signed by Google) |
| `windows-x86_64` | theseus-rs/postgresql-binaries' build of the same Postgres, cut down; ~29 MB | Chrome for Testing's, untouched |

Linux runs on any distribution with glibc 2.28 or newer (Debian 10+, Ubuntu 20.04+, RHEL 8+); its archives are
tested on bare Ubuntu 20.04 and Debian 12 with nothing installed. macOS: 11 (Big Sur) and later.

Postgres is built with no ICU, OpenSSL, readline, zlib or other libraries (`visit` connects over 127.0.0.1;
SCRAM passwords don't need OpenSSL); macOS uses the system's time zones, the others carry their own. Each
Postgres archive keeps `postgres`, `initdb`, `pg_ctl`, `psql`, `pg_dump`, `pg_dumpall`, `pg_restore`,
`pg_upgrade` and `pg_isready`. Every archive says how it was made in `BUILD.txt`; a Linux Chrome's libraries
are listed with their packages and licences in `licenses/`.

## The archives

`postgresql-<version>-<build>-<platform>.tar.gz` and `chrome-<version>-<build>-<platform>.tar.gz`: a gzipped tar
with exactly one top directory, named as the file without `.tar.gz`. Inside it:

| | Linux | macOS | Windows |
|---|---|---|---|
| Postgres' programs | `bin/` (`bin/postgres`, `bin/initdb`, `bin/pg_ctl`, …); `lib/`, `share/` beside it | the same | the same, `.exe`, with its DLLs in `bin/` |
| Chrome | `chrome-headless-shell` | `chrome-headless-shell` | `chrome-headless-shell.exe` |

Postgres finds its `lib/` and `share/` from where its `bin/` is: unpacked anywhere, it runs as it is (initdb
with `--locale-provider=builtin --builtin-locale=C.UTF-8` gives the same database on every platform).

### How `visit` starts Chrome (the engine follows this exactly)

- **Linux**: run `<top>/chrome-headless-shell` with two variables set **for Chrome's process only** (it and the
  processes it starts inherit them; `visit`'s own environment stays as it is):
  - `LD_LIBRARY_PATH=<top>/lib` (the libraries it needs, ahead of the machine's own);
  - `FONTCONFIG_FILE=<top>/fonts/fonts.conf` (DejaVu Sans, Serif and Sans Mono, and no other fonts: the same
    text on every machine; without it a bare machine draws no text at all). Fontconfig keeps its cache in
    `$XDG_CACHE_HOME/basedverse-fontconfig` (else `~/.cache/basedverse-fontconfig`).
- **macOS, Windows**: run `<top>/chrome-headless-shell` (`.exe` on Windows) as it is; the system's fonts.
- **Everywhere**: `--disable-gpu --enable-unsafe-swiftshader` (WebGL 2 through SwiftShader: no GPU used or
  needed), `--no-first-run --no-default-browser-check`, a `--user-data-dir` of its own. Chrome's own sandbox
  first; where the place allows none (a container, usually: it dies at start saying so), again with
  `--no-sandbox`, as the engine has always done.

`deps/chrome/test` starts it exactly this way.

## The scripts

| file | what it is |
|---|---|
| `versions.env` | the versions, our build numbers, every input's sha256 (Chrome for Testing publishes none: ours, of its zips), the build and test images by digest |
| `lib.sh` | what the scripts share |
| `postgres/build <platform> [--no-test]` | makes `dist/postgresql-…-<platform>.tar.gz`, then runs `postgres/test` on it |
| `postgres/linux-inside.sh`, `postgres/macos.sh` | the Linux build (in the container) and the macOS build (on the Mac) |
| `postgres/test <archive>` | unpacked somewhere new: initdb, start, a SCRAM role, LISTEN/NOTIFY, an advisory lock, JSONB/BYTEA, stop |
| `chrome/build <platform> [--no-test]` | makes `dist/chrome-…-<platform>.tar.gz`, then runs `chrome/test` on it |
| `chrome/linux-inside.sh` | packs the libraries (following `ldd`, plus what NSS loads by name) and fonts, in the container |
| `chrome/test <archive>`, `chrome/test.html` | unpacked somewhere new, started as above on `test.html`: WebGL 2 with a shader compiled, text on a 2D canvas |
| `pin <n>` / `pin --local` | writes `pinned.json` from the release `deps-<n>`, or from `dist/` (file:// URLs, only what is there) |
| `../.github/workflows/deps.yml` | builds and tests both on every platform's own runner; publishes on a tag |

A Linux archive is built in Docker on any Linux machine (`deps/chrome/build linux-x86_64`: under a minute;
Postgres about a minute) and tested in Docker on the bare images. A macOS or Windows one is built and tested on
that platform (the workflow's runners); the Intel Mac's is made on Apple silicon and checked, not run.

## `pinned.json`

What `visit`'s build reads: one release of the deps, every platform's archive of each.

```json
{
  "release": "deps-1",
  "postgres": {
    "version": "18.6", "build": 1,
    "files": {
      "linux-x86_64": { "name": "postgresql-18.6-1-linux-x86_64.tar.gz", "url": "https://github.com/sarmiena/Basedverse/releases/download/deps-1/postgresql-18.6-1-linux-x86_64.tar.gz", "sha256": "…" },
      "linux-aarch64": { … }, "macos-aarch64": { … }, "macos-x86_64": { … }, "windows-x86_64": { … }
    }
  },
  "chrome": { "version": "156.0.8078.73", "build": 1, "files": { the same five platforms } }
}
```

`deps/pin --local` writes the same with `"release": "local"`, `file://` URLs into `deps/dist/`, and only the
platforms built here: for building `visit` against archives made on this machine. Don't commit that one.

## Upgrading Postgres or Chrome

1. In `versions.env`: the new version and its inputs' sha256s (Postgres' source:
   `https://ftp.postgresql.org/pub/source/v<version>/postgresql-<version>.tar.bz2.sha256`, and theseus-rs'
   Windows build of it; Chrome: `sha256sum` of each of the five zips from
   [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/)). The build number back to 1
   for a new version; the next number to rebuild the same one. Newer build images: `docker buildx imagetools
   inspect <image>` gives the digest.
2. Try it here: `deps/postgres/build linux-x86_64`, `deps/chrome/build linux-x86_64`.
3. Commit and push: the `deps` workflow builds and tests everything on every platform.
4. Tag it `deps-<n+1>` and push the tag: the workflow publishes the release `deps-<n+1>`.
5. `deps/pin <n+1>`, build and test `visit`, commit `deps/pinned.json`.

Visit's own releases are untouched by this: a `visit` is built with whatever `pinned.json` says at its commit.

A new **major** Postgres (18 to 19) also needs `visit` to move an existing database over with `pg_upgrade` (kept
in the archive for that): a new minor one (18.6 to 18.7) is only a new archive.
