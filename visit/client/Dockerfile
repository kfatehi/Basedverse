# visit-client in a container: built in the official Rust image, run from a slim Debian one. Run it on the
# host's network: it binds 127.0.0.1 only, so the browser on the same machine reaches it and nothing else
# does, while its links to other offices go out through the host's network like any program's.
FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src src
COPY web web
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/src/target \
    cargo build --release && cp target/release/visit-client /visit-client

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /visit-client /usr/local/bin/visit-client
USER nobody
ENTRYPOINT ["visit-client"]
