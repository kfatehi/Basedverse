# deps/lib.sh: what deps/<postgres|chrome>/build and test share. Sourced, never run; bash 3.2 (macOS) safe.
deps="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "$deps/versions.env"
PLATFORMS="linux-x86_64 linux-aarch64 macos-aarch64 macos-x86_64 windows-x86_64"

say() { echo "deps/${what:-?}: $*" >&2; }
die() { say "$*"; exit 1; }
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
# platform_ok <platform>: one of PLATFORMS
platform_ok() { case " $PLATFORMS " in *" $1 "*) return 0 ;; esac; return 1; }
# upper <platform>: its name as versions.env spells it (linux-x86_64 -> LINUX_X86_64)
upper() { echo "$1" | tr 'a-z-' 'A-Z_'; }
# fetch <url> <file> <sha256>: downloads once (kept while its sha256 is right), and refuses a file that isn't it
fetch() {
  if [ ! -f "$2" ] || [ "$(sha256 "$2")" != "$3" ]; then
    say "fetching $1"
    curl -fsSL -o "$2.part" "$1" && mv "$2.part" "$2"
  fi
  [ "$(sha256 "$2")" = "$3" ] || die "$(basename "$2") is not the sha256 in deps/versions.env: refused"
}
# unzip_to <zip> <dir>: unzip where there is one, else 7-Zip (a Windows runner has both; keep permissions and links)
unzip_to() { if command -v unzip >/dev/null; then unzip -q "$1" -d "$2"; else 7z x -y -o"$2" "$1" >/dev/null; fi; }
# pack <dir holding the top directory> <top directory> <archive>: one top directory, no macOS metadata files
pack() { COPYFILE_DISABLE=1 tar -czf "$3" -C "$1" "$2"; say "$3 ($(du -h "$3" | cut -f1)), sha256 $(sha256 "$3")"; }
