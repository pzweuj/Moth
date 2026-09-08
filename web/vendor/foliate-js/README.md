# Moth Foliate subset

This directory contains the pinned Foliate EPUB parser/CFI/paginator subset
used by Moth. PDF.js, MOBI/KF8, FB2, ComicBook, OPDS, dictionary, demo and
upstream test assets are intentionally removed. Moth's Rust server converts
classic DRM-free MOBI to a minimal EPUB; CBZ is served page-by-page by Axum.

Keep the upstream MIT `LICENSE` and the reviewed commit pin when updating this
subset. The application supplies its own zip.js HTTP Range loader.
