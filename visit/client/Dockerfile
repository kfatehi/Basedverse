# visit in a container: built in the official Rust image from the workspace (../../Cargo.toml), run from a slim
# Debian one. Build from the repository's root: docker build -f visit/client/Dockerfile -t visit .
# For development: what a workroom runs is the one file (./build, or a release), never this image.
FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY visit/client visit/client
COPY auth/client auth/client
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/src/target \
    cargo build --release --locked -p visit && cp target/release/visit /visit

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /visit /usr/local/bin/visit
USER nobody
ENTRYPOINT ["visit"]
