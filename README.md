# Moth

Moth is a self-hosted, online-first web reader for EPUB, TXT, CBZ, and MOBI
books. The original library is mounted read-only; the database, metadata,
covers, indexes, verified snapshots, and caches belong in the writable data
directory. Reading units are cached automatically after they are opened, so a
short loss of connectivity does not interrupt rereading those units.

Implemented so far:

- **Foundation** — Rust/Axum service, SQLite persistence, a single user
  account (Moth is self-hosted, so there is no administrator/regular-user
  split), and the React/Vite application shell.
- **Library** — background scanning of the library directory across all four
  formats, metadata and cover extraction, a bookshelf with search and format
  filters, custom sections and book series, reading content (chapters, comic
  pages, EPUB resources), and single-user reading progress. Books can be
  organized as `section → series → book`, with independent books living
  directly in a section. Parsing is done by the `moth-format` crate
  (EPUB via `zip` + `quick-xml`, MOBI via `mobi`, CBZ via `zip`, TXT via
  `chardetng`/`encoding_rs`).
- **Reader and local cache** — paginated EPUB/TXT/MOBI reading, lazy CBZ
  paging, contents navigation, reader settings, TXT encoding overrides, CFI
  restoration, serialised progress saves, a PWA shell, and IndexedDB storage
  for visited chapters, comic pages, resources, and local-first progress.
  Whole-book downloads are not part of the product flow; an uncached chapter
  or page clearly asks for a connection.

The reader view, online-first cache, and manual library organization are
implemented. Remaining release work is browser and Docker acceptance on
desktop, Android, and iPhone, plus real MOBI/AZW3 fixture validation.

## Local development

Requirements:

- Rust 1.97.1 (the repository includes `rust-toolchain.toml`)
- Node.js 22 LTS and pnpm 11.19.0

Start the API server:

```powershell
$env:MOTH_DATA_DIR = ".local/data"
$env:MOTH_BOOKS_DIR = ".local/books"
$env:MOTH_WEB_DIR = "web/dist"
cargo run -p moth-server
```

In another terminal, install and start the Vite development server:

```powershell
pnpm install
pnpm --dir web dev
```

The Vite server runs at <http://127.0.0.1:5373> by default and proxies `/api` to Axum at
<http://127.0.0.1:8080>. The API can run without `web/dist`; the production
static shell is served only when that directory exists. Set `VITE_PORT` in
PowerShell before starting if you need another available port, for example
`$env:VITE_PORT = "6000"`.

To populate the library with sample books (TXT, CBZ, EPUB) for manual testing:

```powershell
cargo run -p moth-server --example make_books -- .local/books
```

The server indexes the library in the background on startup; `Rescan library`
in the app re-scans without a restart.

## Configuration

The server reads the following environment variables. Invalid addresses,
booleans, session TTLs, log filters, database paths, or migration failures stop
startup with an actionable error.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MOTH_BIND_ADDR` | `0.0.0.0:8080` | Listen address and port. |
| `MOTH_DATA_DIR` | `/data` | Writable directory containing `moth.db`. |
| `MOTH_BOOKS_DIR` | `/books` | Original library directory; Phase 0 does not write to it. |
| `MOTH_WEB_DIR` | `web/dist` | Vite production output directory. |
| `MOTH_COOKIE_SECURE` | `false` | Set `true` when HTTPS is terminated by a reverse proxy. |
| `MOTH_SESSION_TTL_DAYS` | `30` | Positive session lifetime in days. |
| `MOTH_LOG` | `info` | `tracing` filter, for example `info,moth_server=debug`. |

The application never logs passwords, cookies, or raw session tokens. There is
no configuration that disables authentication.

## Docker Compose

The production image is a single non-root service that serves both the compiled
web app and the API:

```powershell
New-Item -ItemType Directory -Force data, books
Copy-Item .env.example .env
docker compose up --build -d
docker compose ps
```

Open <http://localhost:8080>. On the first visit, set up the single user account
on `/setup`, then sign in. Setup and login are deliberately separate API calls.
The browser keeps only the HttpOnly `moth_session` cookie; credentials are not
stored in browser storage.

Compose mounts `./data` at `/data` and `${MOTH_BOOKS_PATH:-./books}` at
`/books:ro`. `MOTH_BOOKS_PATH` is a Compose host-path substitution only; it is
not read by the server. To use an absolute library path, set it in `.env` or in
the shell before running Compose. Keep `/data` backed up and never put the
database or cache files in the source library.

The image uses UID/GID `10001` for the `moth` user. On Linux, prepare a bind
mount with:

```bash
mkdir -p data books
sudo chown -R 10001:10001 data
```

Windows and Docker Desktop manage the bind-mount permissions through the file
sharing settings. The `/books` mount remains read-only in both environments.

For a reverse-proxy deployment, terminate TLS at the proxy and set
`MOTH_COOKIE_SECURE=true`. The application does not provide TLS itself. Keep
the proxy on the same origin as the app so the `SameSite=Lax` session cookie is
sent normally.

To update a local image, rebuild and recreate the service:

```powershell
docker compose build --pull
docker compose up -d
```

For a safe SQLite backup, stop Moth first so the WAL is checkpointed, copy the
entire data directory, then start it again:

```powershell
docker compose stop moth
Copy-Item -Recurse -Force data ("data-backup-{0:yyyyMMdd-HHmmss}" -f (Get-Date))
docker compose start moth
```

The health check calls `/api/v1/health`. Inspect it with
`docker compose ps` or `docker inspect`; a healthy container is ready to serve
both API and web requests.

## Checks

Run the same checks used by CI before committing:

```powershell
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm --dir web lint
pnpm --dir web test --run
pnpm --dir web build
cargo build --release --workspace
docker compose config
docker compose build
```

The same Rust, frontend, and container checks run in [GitHub Actions](.github/workflows/ci.yml).

When Docker is unavailable locally, the Rust and web checks can still run, and
CI can build the image. A Phase 0 release is not complete until a
Docker-capable environment also performs the setup → login → restart → logout
smoke test, mount-permission checks, and graceful stop described in
[`docs/phase-0-acceptance.md`](docs/phase-0-acceptance.md).

Moth is licensed under Apache-2.0.
