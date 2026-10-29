#!/usr/bin/env bash
# deps/postgres/build's Linux half, run inside the manylinux_2_28 container (as root: it adds flex, which Postgres
# 18's source needs; what it makes is handed to OWNER, the uid:gid that ran the build): compiles Postgres into <out>
# so it runs from wherever it is unpacked (Postgres finds its lib and share beside its bin; the programs find libpq through
# $ORIGIN), with nothing but the C library under it: no ICU, OpenSSL, readline or compression libraries.
#   linux-inside.sh <postgresql-x.y.tar.bz2> <out>
set -euo pipefail
src="$1" out="$2"
# what it makes is the caller's, even when it fails part way
trap 'chown -R "$OWNER" "$(dirname "$out")"' EXIT
dnf -y -q install flex >/dev/null
cd /tmp && tar -xjf "$src" && cd postgresql-*/
# Local connections only, so no TLS; SCRAM passwords work without OpenSSL (Postgres' own SHA-256).
./configure --prefix="$out" --without-icu --without-readline --without-zlib --without-zstd --without-lz4 \
  --without-openssl --without-libxml --without-perl --without-python --without-tcl --without-gssapi \
  --without-ldap --without-pam --without-selinux --without-systemd >/tmp/configure.log 2>&1 \
  || { tail -40 /tmp/configure.log; exit 1; }
make -j"$(nproc)" -s world-bin >/tmp/make.log 2>&1 || { tail -60 /tmp/make.log; exit 1; }
make -s install-world-bin >/tmp/install.log 2>&1 || { tail -40 /tmp/install.log; exit 1; }
cp COPYRIGHT "$out/"
for f in "$out"/bin/* "$out"/lib/*.so* "$out"/lib/postgresql/*.so; do
  [ -f "$f" ] && [ ! -L "$f" ] || continue
  if file "$f" | grep -q ELF; then
    patchelf --set-rpath '$ORIGIN/../lib' "$f" 2>/dev/null || true
    strip --strip-unneeded "$f"
  fi
done
echo "linux-inside: $("$out/bin/postgres" --version), glibc $(ldd --version | head -1 | awk '{print $NF}')"
