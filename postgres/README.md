# postgres

The Postgres that `visit` runs beside itself (#22). Nobody installs it: on first start `visit` downloads the
archive for its platform from this repository's release `postgres-<version>-<build>`, checks it against the
sha256 it was built with (`visit/client/postgres.json`), unpacks it into its data directory and keeps it until
the pinned version changes. This directory makes those archives.

| file | what it is |
|---|---|
| `versions.env` | the Postgres version, our build number, the source's sha256, the build images (pinned by digest) |
| `build <platform>` | makes `dist/postgresql-<version>-<build>-<platform>.tar.gz`, then runs `test` on it |
| `linux-inside.sh` | `build`'s Linux half, run inside the build container |
| `test <archive>` | unpacks an archive somewhere new and uses it the way `visit` does |
| `pin` | points `visit/client/postgres.json` at a published release |
| `../.github/workflows/postgres.yml` | runs `build` on each platform and publishes the release |

## Where each platform's Postgres comes from

- **Linux** (`linux-x86_64`, `linux-aarch64`): compiled here from the official source tarball, in a
  manylinux_2_28 container (glibc 2.28: Debian 10+, Ubuntu 20.04+, RHEL 8+), with nothing but the C library
  under it (no ICU, OpenSSL, readline or compression libraries: `visit` connects over 127.0.0.1, and SCRAM
  passwords don't need OpenSSL). Tested on Ubuntu 20.04. About 7 MB.
- **macOS** (`macos-aarch64`, `macos-x86_64`) and **Windows** (`windows-x86_64`): the build of the same Postgres
  from [theseus-rs/postgresql-binaries](https://github.com/theseus-rs/postgresql-binaries), checked against the
  sha256 it publishes, then cut down (headers, static libraries, docs and the programs `visit` doesn't use go).
  Once in our release, `visit` never reaches theseus-rs.

Every archive keeps `postgres`, `initdb`, `pg_ctl`, `psql`, `pg_dump`, `pg_dumpall`, `pg_restore`, `pg_upgrade`
and `pg_isready`, and says how it was made in `BUILD.txt`.

## A new Postgres (or a rebuild)

1. In `versions.env`: `POSTGRES_VERSION` and `POSTGRES_SHA256` (from
   `https://ftp.postgresql.org/pub/source/v<version>/postgresql-<version>.tar.bz2.sha256`), and
   `THESEUS_RELEASE` (theseus-rs' release of that version). `BUILD=1` for a new version; the next number to
   rebuild the same one. Newer build images: `docker buildx imagetools inspect <image>` gives the digest.
2. Try it here: `postgres/build linux-x86_64` (Docker; about a minute) builds and tests it.
3. Commit, push, then Actions → **postgres** → Run workflow, with **publish**. Every platform is built and
   tested on its own runner (the Intel Mac's is checked, not run).
4. `postgres/pin`, then build and test visit against it, and commit `visit/client/postgres.json`.

A new **major** version (18 → 19) also needs `visit` to move an existing data directory over with `pg_upgrade`
(kept in the archive for that); a minor one (18.6 → 18.7) is only a new archive.

Docker is used here and in CI to build; nothing that runs `visit` needs it.
