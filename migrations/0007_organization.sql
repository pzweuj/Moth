-- User-managed library organization.  Classification is derived from the
-- nullable book links: a direct book has section_id, while a series member
-- has series_id and inherits the series' section.
CREATE TABLE sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_system INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE RESTRICT,
    name TEXT NOT NULL COLLATE NOCASE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (section_id, name COLLATE NOCASE)
);

ALTER TABLE books ADD COLUMN section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL;
ALTER TABLE books ADD COLUMN series_id INTEGER REFERENCES series(id) ON DELETE SET NULL;
ALTER TABLE books ADD COLUMN series_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE books ADD COLUMN missing INTEGER NOT NULL DEFAULT 0;

CREATE INDEX books_section_idx ON books (section_id);
CREATE INDEX books_series_idx ON books (series_id, series_order);
CREATE INDEX books_identity_idx ON books (sha256, file_size, format);
CREATE INDEX series_section_idx ON series (section_id, sort_order);

INSERT INTO sections (name, sort_order, is_system, created_at, updated_at)
VALUES ('Unclassified', 0, 1, strftime('%s', 'now'), strftime('%s', 'now'));

UPDATE books
SET section_id = (SELECT id FROM sections WHERE is_system = 1)
WHERE section_id IS NULL AND series_id IS NULL;
