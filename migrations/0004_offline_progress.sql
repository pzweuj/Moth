-- Content versions and monotonic revisions make local-first progress sync
-- safe when a device reconnects after another device has advanced.
ALTER TABLE reading_progress ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reading_progress ADD COLUMN content_version TEXT;
ALTER TABLE reading_progress ADD COLUMN cfi TEXT;

CREATE INDEX reading_progress_revision_idx ON reading_progress (book_id, revision);

CREATE TABLE progress_operations (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (book_id, operation_id)
);
