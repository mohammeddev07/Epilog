-- The live entry's catalog ID (NULL for tombstones and other kinds), for merging the same title logged on two devices.
ALTER TABLE records ADD COLUMN catalog_ref TEXT;
CREATE INDEX records_user_catalog_ref ON records (user_id, catalog_ref);
-- Lets each sync find and purge old tombstones without scanning live rows.
CREATE INDEX records_user_tombstones ON records (user_id, updated_at) WHERE deleted = 1;
-- The highest revision whose tombstone was purged; a device with an older cursor gets a reset.
ALTER TABLE users ADD COLUMN purged_before INTEGER NOT NULL DEFAULT 0;
-- A remapped entry id and the canonical id it now lives under, so late pushes and other devices follow it.
CREATE TABLE aliases (
  user_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (user_id, from_id)
);
CREATE INDEX aliases_user_revision ON aliases (user_id, revision);
