# The perf test's node: Python (the lobby, and the fake pages), tc (the network it is given), and a
# visit-client mounted in from the build. One image for every container of a run.
FROM python:3.13-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir --root-user-action=ignore websockets==15.0.1
