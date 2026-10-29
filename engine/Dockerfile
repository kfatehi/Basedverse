# visit-engine (SPEC 5): a headless Chromium and the driver (driver/engine.py, Python's standard library), as an
# unprivileged user. Build: docker build -t visit-engine engine. Run: see README.md; settings in SPEC 5.2.
FROM debian:bookworm-slim
# Debian's Chromium, and its setuid sandbox helper for the containers that let it make namespaces (where one does
# not, Chromium says so and the driver starts it again with --no-sandbox: the container is the boundary then).
# Mesa's GL and the LLVM under it (160 MB) go: WebGL here is SwiftShader over Vulkan, Chromium's own, never
# Mesa's; chromium-common depends on them all the same. fonts-dejavu-core: text on a 2D canvas (a sign).
RUN apt-get update && apt-get install -y --no-install-recommends chromium chromium-sandbox python3 fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && dpkg --purge --force-depends libgl1-mesa-dri libllvm15 libz3-4 adwaita-icon-theme
RUN useradd --create-home --uid 1000 --user-group engine
COPY VERSION /engine/VERSION
COPY driver /engine/driver
# Any uid may run it (compose's `user:`): the profile goes under /tmp, and so does home.
ENV HOME=/tmp
USER engine
ENTRYPOINT ["python3", "-u", "/engine/driver/engine.py"]
