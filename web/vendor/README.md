# Vendored libraries

## foliate-js

Pinned at commit `78914aef4466eb960965702401634c2cb348e9b1` (2026-09-06).

- MIT licensed, upstream: https://github.com/johnfactotum/foliate-js
- Per the reader tech selection (`docs/reader-tech-selection.md`), foliate-js is
  vendored as a git clone (commit-pinned, not a rolling `npm install`) because
  its API is not stable. Update by re-cloning at a new commit and re-checking
  the integration.
- **Additions (not from upstream):** the `*.d.ts` files in this tree. They are
  minimal ambient type declarations for the modules Moth imports; they do not
  change upstream code.
- The vendored `vendor/zip.js` is a trimmed build without `HttpRangeReader`.
  Moth's range-based loading uses the full `@zip.js/zip.js` npm package instead
  (see `web/src/reader/zipLoader.ts`).
