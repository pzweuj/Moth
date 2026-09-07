-- Stable identity for browser storage isolation. The value is generated only
-- when the database is first migrated and survives restarts and rescans.
CREATE TABLE IF NOT EXISTS server_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO server_metadata (key, value)
SELECT 'instance_id', lower(hex(randomblob(16)))
WHERE NOT EXISTS (SELECT 1 FROM server_metadata WHERE key = 'instance_id');
