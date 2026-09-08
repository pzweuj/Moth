-- Moth core schema. The database is an index/cache for read-only files.
-- Existing pre-core databases are intentionally not migrated; remove moth.db
-- and rescan after upgrading.

CREATE TABLE user_account (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE directories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER REFERENCES directories(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (relative_path)
);
CREATE INDEX directories_parent_idx ON directories (parent_id, name COLLATE NOCASE);

CREATE TABLE publications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    directory_id INTEGER NOT NULL REFERENCES directories(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    filename TEXT NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('epub', 'txt', 'cbz', 'mobi')),
    title TEXT NOT NULL,
    author TEXT,
    file_size INTEGER NOT NULL,
    mtime_ns INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    has_cover INTEGER NOT NULL DEFAULT 0,
    parse_status TEXT NOT NULL DEFAULT 'ok',
    parse_error TEXT,
    added_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (relative_path)
);
CREATE INDEX publications_directory_idx ON publications (directory_id);
CREATE INDEX publications_format_idx ON publications (format);
CREATE INDEX publications_hash_idx ON publications (sha256, file_size, format);

CREATE TABLE text_chapters (
    publication_id INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
    encoding TEXT NOT NULL,
    idx INTEGER NOT NULL,
    title TEXT NOT NULL,
    byte_start INTEGER NOT NULL,
    byte_end INTEGER NOT NULL,
    character_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (publication_id, encoding, idx)
);
CREATE INDEX text_chapters_lookup_idx ON text_chapters (publication_id, encoding, idx);

CREATE TABLE cbz_pages (
    publication_id INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    path TEXT NOT NULL,
    mime TEXT NOT NULL,
    PRIMARY KEY (publication_id, idx)
);

CREATE TABLE reading_progress (
    publication_id INTEGER PRIMARY KEY REFERENCES publications(id) ON DELETE CASCADE,
    content_version TEXT NOT NULL,
    locator_json TEXT NOT NULL,
    progress REAL NOT NULL CHECK (progress >= 0 AND progress <= 1),
    updated_at INTEGER NOT NULL
);
