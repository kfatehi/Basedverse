#!/usr/bin/env bash
# deps/postgres/build's macOS half, run on the Mac itself (Xcode's command-line tools: clang, make, bison, flex,
# perl): compiles Postgres into <out> for <arch> (arm64, or x86_64: cross-compiled on Apple silicon), for macOS
# <target> and later, with nothing under it but the system's own libraries and time zones. Then makes it run from
# wherever it is unpacked: Postgres finds its lib and share beside its bin by itself; every program and library
# finds libpq through @rpath, relative to itself; each is signed again (ad hoc) after the change, as Apple
# silicon requires.
#   macos.sh <postgresql-x.y.tar.bz2> <out> <arm64|x86_64> <deployment target>
set -euo pipefail
src="$1" out="$2" arch="$3" target="$4"
build=$(mktemp -d "${TMPDIR:-/tmp}/pgbuild.XXXXXX")
trap 'rm -rf "$build"' EXIT
tar -xjf "$src" -C "$build"
cd "$build"/postgresql-*/
cross=""
[ "$arch" = "$(uname -m)" ] || cross="--host=$arch-apple-darwin --build=$(uname -m)-apple-darwin"
export MACOSX_DEPLOYMENT_TARGET="$target"
# headerpad: room for the @rpath load commands added below
# shellcheck disable=SC2086
./configure --prefix="$out" $cross CC="clang -arch $arch" LDFLAGS="-Wl,-headerpad_max_install_names" \
  --with-system-tzdata=/usr/share/zoneinfo --without-icu --without-readline --without-zlib --without-zstd \
  --without-lz4 --without-openssl --without-libxml --without-perl --without-python --without-tcl \
  --without-gssapi --without-ldap --without-pam --without-bonjour >"$build/configure.log" 2>&1 \
  || { tail -40 "$build/configure.log"; exit 1; }
make -j"$(sysctl -n hw.ncpu)" -s world-bin >"$build/make.log" 2>&1 || { tail -60 "$build/make.log"; exit 1; }
make -s install-world-bin >"$build/install.log" 2>&1 || { tail -40 "$build/install.log"; exit 1; }
cp COPYRIGHT "$out/"

# Relocatable: libraries named @rpath/<name>, what pointed at "$out/lib/<name>" pointed at @rpath/<name>, and an
# rpath to the lib directory from where each file is.
for f in "$out"/bin/* "$out"/lib/*.dylib "$out"/lib/postgresql/*; do
  [ -f "$f" ] && [ ! -L "$f" ] && file "$f" | grep -q Mach-O || continue
  strip -x "$f" 2>/dev/null || true
  case "$f" in
    "$out"/lib/postgresql/*) rpath=@loader_path/.. ;;
    "$out"/lib/*) rpath=@loader_path
                  install_name_tool -id "@rpath/$(basename "$(otool -D "$f" | tail -1)")" "$f" ;;
    *) rpath=@loader_path/../lib ;;
  esac
  for dep in $(otool -L "$f" | tail -n +2 | awk '{print $1}' | grep "^$out/lib/" || true); do
    install_name_tool -change "$dep" "@rpath/$(basename "$dep")" "$f"
  done
  otool -l "$f" | grep -q "path $rpath " || install_name_tool -add_rpath "$rpath" "$f"
  codesign --force --sign - "$f" 2>/dev/null
done
left=$(for f in "$out"/bin/* "$out"/lib/*.dylib "$out"/lib/postgresql/*; do
  [ -f "$f" ] && [ ! -L "$f" ] && file "$f" | grep -q Mach-O && otool -L "$f" | grep -F "$out/" || true; done)
[ -z "$left" ] || { echo "macos.sh: still pointing into the build's prefix:"; echo "$left"; exit 1; }
echo "macos.sh: Postgres for $arch ($(lipo -archs "$out/bin/postgres")), macOS $target and later, relocatable"
