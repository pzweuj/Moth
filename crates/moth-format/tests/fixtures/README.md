# Real MOBI acceptance fixture

`alice.mobi` is the unchanged Project Gutenberg edition of Lewis Carroll's
*Alice's Adventures in Wonderland* (ebook 11), downloaded 2026-09-08.

- Catalogue and rights: https://www.gutenberg.org/ebooks/11
- Download (Older Kindles / MOBI): https://www.gutenberg.org/ebooks/11.kindle.images
- Catalogue rights statement: “Public domain in the USA.” Lewis Carroll died in 1898.
- The file includes the Project Gutenberg license and notices; retain them when redistributing this fixture. See https://www.gutenberg.org/policy/license.html.
- No DRM; original BOOKMOBI container, 241000 bytes.
- SHA-256: `29448cd44f3e6d3db391c6aefc438f53283142d9e8a41ef439718a5d84f36240`.
- Expected content: Alice, White Rabbit, “Down the Rabbit-Hole”, “The Pool of Tears”, twelve story chapters and Gutenberg notices.

The Rust test verifies parser output. Playwright separately exercises the
actual Foliate rendering, navigation, local caching and restored reading.
This MOBI fixture does not establish AZW3/KF8 compatibility.
