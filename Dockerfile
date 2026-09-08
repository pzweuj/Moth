# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS web-builder
WORKDIR /src

RUN corepack enable \
    && corepack prepare pnpm@11.19.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile

COPY web web
RUN pnpm --dir web build

FROM rust:1.97.1-bookworm AS server-builder
WORKDIR /src

COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates crates
COPY migrations migrations
RUN cargo build --release -p moth-server

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install --no-install-recommends --yes ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 10001 moth \
    && useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent --no-create-home moth \
    && mkdir -p /app/web /data /books /config \
    && chown -R moth:moth /app /data /books

COPY --from=server-builder /src/target/release/moth-server /app/moth-server
COPY --from=web-builder /src/web/dist /app/web
RUN chown -R moth:moth /app

ENV MOTH_BIND_ADDR=0.0.0.0:8080 \
    MOTH_DATA_DIR=/data \
    MOTH_BOOKS_DIR=/books \
    MOTH_WEB_DIR=/app/web \
    MOTH_COOKIE_SECURE=false \
    MOTH_SESSION_TTL_DAYS=30 \
    MOTH_LOG=info

WORKDIR /app
USER moth
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl --fail --silent --show-error http://127.0.0.1:8080/api/v1/health || exit 1

ENTRYPOINT ["/app/moth-server"]
