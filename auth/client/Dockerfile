# auth-client in a container: built in the official Rust image, run from a slim Debian one. Run it on the host's
# network, or in the workroom's server's network namespace: it binds 127.0.0.1 only, and only that server talks
# to it.
FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src src
COPY migrations migrations
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/src/target \
    cargo build --release && cp target/release/auth-client /auth-client

FROM debian:bookworm-slim
COPY --from=build /auth-client /usr/local/bin/auth-client
USER nobody
ENTRYPOINT ["auth-client"]
