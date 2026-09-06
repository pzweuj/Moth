-- Moth is self-hosted with a single account: the library owner.
-- Rename the Phase 0 "admin" table to reflect that there is only a user,
-- not an administrator/regular-user split. The id = 1 single-row semantics
-- and the sessions table (which has no foreign key to this table) are unchanged.
ALTER TABLE admin_credentials RENAME TO user_account;
