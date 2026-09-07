-- TXT locations are tied to the decoded chapter layout. Keep the encoding
-- alongside the content hash so a GBK CFI is never compared with UTF-8.
ALTER TABLE reading_progress ADD COLUMN encoding TEXT;
