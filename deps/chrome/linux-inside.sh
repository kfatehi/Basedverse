#!/usr/bin/env bash
# deps/chrome/build's Linux half, run inside the manylinux_2_28 container (AlmaLinux 8, glibc 2.28) as root: the
# headless shell from <zip> into <out>, with every library it needs that isn't the C library itself in <out>/lib
# (found by following ldd from the program and its own libraries, plus what NSS loads by name), and fonts with a
# fonts.conf in <out>/fonts, so it runs on a machine with nothing installed. What it makes is handed to OWNER.
# The launch contract (deps/README.md): LD_LIBRARY_PATH=<out>/lib FONTCONFIG_FILE=<out>/fonts/fonts.conf.
#   linux-inside.sh <chrome-headless-shell-linux*.zip> <out>
set -euo pipefail
zip="$1" out="$2"
# what it makes is the caller's, even when it fails part way
trap 'chown -R "$OWNER" "$(dirname "$out")"' EXIT
pkgs="nss nspr libX11 libXcomposite libXdamage libXext libXfixes libXrandr alsa-lib atk at-spi2-atk at-spi2-core
      dbus-libs expat mesa-libgbm glib2 libxcb libxkbcommon dejavu-sans-fonts dejavu-sans-mono-fonts dejavu-serif-fonts unzip"
# with their docs: the licence files go into the archive (the image installs none by default)
# shellcheck disable=SC2086
dnf -y -q --setopt=tsflags= install $pkgs >/dev/null
tmp=$(mktemp -d) && unzip -q "$zip" -d "$tmp"
mkdir -p "$out" && mv "$tmp"/chrome-headless-shell-linux*/* "$out"/
mkdir -p "$out/lib" "$out/fonts" "$out/licenses"

# The C library's own (always the machine's), and libgcc_s, which every glibc system has (glibc itself needs it).
system='^(linux-vdso|ld-linux|libc\.so|libm\.so|libmvec\.so|libpthread\.so|libdl\.so|librt\.so|libresolv\.so|libutil\.so|libanl\.so|libnss_|libthread_db|libBrokenLocale|libgcc_s\.so)'
queue="$out/chrome-headless-shell $(ls "$out"/*.so* 2>/dev/null | tr '\n' ' ')"
# NSS loads its token and crypto libraries by name, beside libnss3: ldd never sees them.
for n in libsoftokn3.so libfreeblpriv3.so libfreebl3.so libnssdbm3.so; do
  cp -L "/usr/lib64/$n" "$out/lib/$n"; queue="$queue $out/lib/$n"
  [ -f "/usr/lib64/${n%.so}.chk" ] && cp "/usr/lib64/${n%.so}.chk" "$out/lib/"
done
while [ -n "${queue// /}" ]; do
  next=""
  for f in $queue; do
    while read -r soname path; do
      echo "$soname" | grep -qE "$system" && continue
      [ -e "$out/$soname" ] || [ -e "$out/lib/$soname" ] && continue
      cp -L "$path" "$out/lib/$soname"
      next="$next $out/lib/$soname"
    done < <(ldd "$f" | awk '$2 == "=>" && $3 ~ /^\// { print $1, $3 }')
  done
  queue="$next"
done
missing=$(for f in "$out/chrome-headless-shell" "$out"/*.so* "$out"/lib/*.so*; do LD_LIBRARY_PATH="$out/lib" ldd "$f" | grep "not found" || true; done | sort -u)
[ -z "$missing" ] || { echo "linux-inside: still missing:"; echo "$missing"; exit 1; }

# Fonts: DejaVu, the only ones the page sees (the same on every machine), and where fontconfig keeps its cache.
cp /usr/share/fonts/dejavu/DejaVuSans.ttf /usr/share/fonts/dejavu/DejaVuSans-Bold.ttf \
   /usr/share/fonts/dejavu/DejaVuSansMono.ttf /usr/share/fonts/dejavu/DejaVuSerif.ttf "$out/fonts/"
cat >"$out/fonts/fonts.conf" <<'EOF'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<!-- visit's headless Chrome: these fonts and no others (deps/README.md). -->
<fontconfig>
  <dir prefix="relative">.</dir>
  <cachedir prefix="xdg">basedverse-fontconfig</cachedir>
  <alias><family>sans-serif</family><prefer><family>DejaVu Sans</family></prefer></alias>
  <alias><family>serif</family><prefer><family>DejaVu Serif</family></prefer></alias>
  <alias><family>monospace</family><prefer><family>DejaVu Sans Mono</family></prefer></alias>
</fontconfig>
EOF

# Where each library and font came from, with its licence (AlmaLinux 8's packages; their sources are AlmaLinux's
# source RPMs of the same versions).
packages=$( (for f in "$out"/lib/*; do rpm -qf "/usr/lib64/$(basename "$f")" 2>/dev/null || true; done
             rpm -qf /usr/share/fonts/dejavu/DejaVuSans.ttf /usr/share/fonts/dejavu/DejaVuSansMono.ttf /usr/share/fonts/dejavu/DejaVuSerif.ttf) \
           | grep -v "not owned" | sort -u)
# (installed again with their docs: the image's tsflags=nodocs leaves some licences out even when asked not to)
packages="$packages
$(rpm -q dejavu-fonts-common)"
# shellcheck disable=SC2086
dnf -y -q --setopt=tsflags= reinstall $packages >/dev/null
for p in $packages; do
  for l in $( (rpm -q --licensefiles "$p"; rpm -qd "$p" | grep -iE '/(COPYING|LICEN[CS]E)[^/]*$') 2>/dev/null | sort -u || true); do
    [ -f "$l" ] && mkdir -p "$out/licenses/$p" && cp "$l" "$out/licenses/$p/"
  done
done
none=$(for p in $packages; do [ -d "$out/licenses/$p" ] || echo "$p"; done)
[ -z "$none" ] || echo "linux-inside: no licence file in these packages (their spec's License tag stands): $(echo $none)"
echo "$packages" >"$out/licenses/PACKAGES.txt"
echo "linux-inside: chrome-headless-shell $("$out/chrome-headless-shell" --version 2>/dev/null | awk '{print $NF}' || echo '?'), $(ls "$out/lib" | wc -l) libraries packed, $(echo "$packages" | wc -l) packages"
