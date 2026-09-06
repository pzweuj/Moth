# Phase 0 Acceptance Record

Date: 2026-09-02

## Scope

This record covers the Phase 0 foundation, single-user flow, web
application shell, production static serving, container definition, and CI.
Library scanning, readers, PWA storage, and offline books remain out of scope.

## Automated checks

| Check | Result | Notes |
| --- | --- | --- |
| `cargo fmt --check` | PASS | Rust 1.97.1 |
| `cargo clippy --workspace --all-targets -- -D warnings` | PASS | No warnings |
| `cargo test --workspace` | PASS | 15 Rust tests |
| `pnpm install --frozen-lockfile` | PASS | pnpm 11.19.0 |
| `pnpm --dir web lint` | PASS | Bundled Node 22 runtime |
| `pnpm --dir web test --run` | PASS | 4 frontend tests |
| `pnpm --dir web build` | PASS | Vite production bundle |
| `cargo build --release --workspace` | PASS | Release binary built |
| `docker compose config` | PENDING | Docker is not installed on this workstation |
| `docker compose build` | PENDING | Requires Docker-capable host or CI |
| Compose smoke test | PENDING | Requires Docker-capable host or CI |

The local pnpm checks use the bundled Node executable and set
`PNPM_CONFIG_MINIMUM_RELEASE_AGE=0` because the managed development runtime
enforces a package release-age policy. The committed CI workflow uses the
standard GitHub Actions Node/pnpm setup and a frozen lockfile.

## Docker-capable acceptance checklist

Run the following from a clean checkout after Docker is available:

```text
docker compose config
docker compose build
docker compose up -d
```

Then verify:

1. `/setup` is shown for an empty `data` directory.
2. Setting up the user account succeeds once; a second setup returns `409` with
   `setup_completed`.
3. Wrong credentials return `401` with the generic `invalid_credentials`
   response; correct credentials return `204` and set an HttpOnly,
   SameSite=Lax, Path=/ cookie.
4. The authenticated home page, health status, deep SPA route refresh, and
   JSON API 404 all work.
5. Restarting the service preserves the user account and an unexpired
   session; logout immediately invalidates only the current session.
6. `docker inspect` reports the `/books` bind mount as read-only and the
   container process UID is not 0. The process can create the SQLite database
   under `/data`.
7. Recreating the container preserves `data/moth.db` and the user account state.
8. `docker compose stop` completes cleanly through SIGTERM, with no panic,
   database error, or lingering process.
9. Container logs contain no password, Cookie header, or raw session token.

The Phase 0 release gate is complete only after the pending Docker checks and
the GitHub Actions workflow pass on a Docker-capable runner.
