# Offline MVP Acceptance Record

Date: 2026-09-07

## Implemented

- The application shell has a Service Worker, manifest, and install icon.
- The production build injects every hashed reader asset into the Service Worker
  precache; a waiting update is applied only after the user chooses Refresh.
- IndexedDB stores staged downloads, fixed-size book chunks, TXT chapters,
  covers, local progress, and retryable sync operations. The database name is
  scoped by the current origin and single-user account so book ids cannot
  collide across self-hosted instances or accounts. Downloads expose an
  authenticated offline manifest and reject known quota shortages without
  evicting existing books.
- EPUB, MOBI, CBZ, and TXT readers use local data when the server is offline.
- Progress writes are local-first and sync through a revisioned endpoint. A
  stale operation keeps the larger percentage; repeated operation IDs are
  idempotent.
- Progress restores a CFI only when the content hash still matches. If a file
  changed, the stale CFI and percentage are discarded; the next save starts a
  new content-version record. TXT progress also carries the selected decoder
  (`auto` or an explicit supported encoding), so locations from different
  decoders are never compared.
- Library scans skip symlinks and do not prune books after an incomplete
  directory read. Book paths are canonicalized before they are opened.
- Book content is rendered in a sandbox without scripts and receives a
  document-level CSP after active elements and dangerous URLs are removed.
- Expired sessions keep downloaded books readable locally; server writes show
  a sign-in state. Pending progress is retained until a later online retry.
- TXT overrides are normalized and cached by content hash, encoding, and parser
  version. CBZ preloads a bounded page window and revokes object URLs outside
  that window.

## Automated verification

| Check | Result |
| --- | --- |
| `cargo fmt --all --check` | PASS |
| `cargo clippy --workspace --all-targets -- -D warnings` | PASS |
| `cargo test --workspace` | PASS (16 format, 21 server unit, 10 API integration) |
| `pnpm --dir web lint` | PASS |
| `pnpm --dir web test --run` | PASS (37 tests) |
| `pnpm --dir web build` | PASS |
| GitHub Actions workflow | CONFIGURED |

## Remaining release checks

Docker is not installed on the development workstation, so compose build,
non-root/read-only mount checks, graceful stop, and setup/login/restart/logout
remain pending. Browser acceptance is also pending on desktop Chrome/Edge,
Android Chrome, and iPhone Safari/PWA, including a cold offline start, quota
failure, rotation, and touch navigation. A real MOBI/AZW3 fixture is still
needed to validate the parser and the client reader together. Playwright is
not added to the default CI because the development environment cannot fetch
new packages; the existing unit/build checks remain required.

## Development workstation smoke

- Setup, login, scan, and the online EPUB download button were exercised
  against generated TXT/EPUB/CBZ fixtures.
- Production static smoke checks returned the Service Worker, manifest, and
  favicon with their dedicated MIME types; API health remained JSON and the
  security headers were present. Build-derived Service Worker caches use a
  content-based version.
- After stopping the local server, the service-worker shell cold-started and
  showed the downloaded EPUB from IndexedDB with an `Offline` session marker.
- The Codex in-app browser did not observe the vendored reader's sandboxed
  `blob:` iframe `load` event, so its reader remained on `Opening…`. This
  environment is not a Chrome/Edge acceptance run; desktop and mobile reader
  verification remains required before release.
