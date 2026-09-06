-- Phase 1: the library. Books are discovered in the read-only library
-- directory and indexed here; all derived content (chapters, resources,
-- covers) lives in the writable data directory.

CREATE TABLE books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author TEXT,
    format TEXT NOT NULL,
    relative_path TEXT NOT NULL UNIQUE,
    file_size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    has_cover INTEGER NOT NULL DEFAULT 0,
    page_count INTEGER NOT NULL DEFAULT 0,
    parse_status TEXT NOT NULL DEFAULT 'ok',
    parse_error TEXT,
    added_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Reading units. For EPUB/TXT/MOBI each row is a chapter stored as HTML
-- (EPUB chapters are sanitized XHTML with resource URLs rewritten to served
-- endpoints). CBZ books do not use this table.
CREATE TABLE chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    UNIQUE (book_id, idx)
);

-- EPUB embedded resources (images, stylesheets, fonts), written to
-- <data>/resources/<book_id>/<idx>; the row maps the served index to its MIME.
CREATE TABLE resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    path TEXT NOT NULL,
    mime TEXT NOT NULL,
    UNIQUE (book_id, idx)
);

-- CBZ pages, served lazily from the original (read-only) archive.
CREATE TABLE pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    path TEXT NOT NULL,
    mime TEXT NOT NULL,
    UNIQUE (book_id, idx)
);

-- Single-user reading progress, one row per book.
CREATE TABLE reading_progress (
    book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    chapter_index INTEGER NOT NULL DEFAULT 0,
    page_index INTEGER NOT NULL DEFAULT 0,
    percent REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);

CREATE INDEX books_format_idx ON books (format);
CREATE INDEX chapters_book_idx ON chapters (book_id, idx);
CREATE INDEX resources_book_idx ON resources (book_id, idx);
CREATE INDEX pages_book_idx ON pages (book_id, idx);
