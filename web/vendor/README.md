# Vendored reader code

`foliate-js` is pinned at commit `78914aef4466eb960965702401634c2cb348e9b1`
(2026-09-06). Moth keeps only the EPUB parser, CFI helpers, paginator,
fixed-layout support and their small browser dependencies. The application
uses the published `@zip.js/zip.js` package for HTTP Range loading.

The vendored code is MIT licensed; retain the upstream `LICENSE` and commit
pin when updating it. It is not a MOBI, PDF, FB2 or CBZ reader: MOBI is
converted by Rust to EPUB before reaching the browser, and CBZ pages are read
from the server page endpoint.
