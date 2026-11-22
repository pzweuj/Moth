CREATE TABLE progress_writers (
    session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
    publication_id INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
    writer_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    PRIMARY KEY (session_hash, publication_id, writer_id)
) WITHOUT ROWID;
CREATE INDEX progress_writers_publication_idx ON progress_writers (publication_id);
