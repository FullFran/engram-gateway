-- Author attribution in shared brains (#21). Engram records no author, so the
-- gateway keeps who wrote each observation, keyed by the brain (slug, as in
-- audit_log) and Engram's observation id. The id, not the sync_id, is the key
-- because mem_update and mem_get_observation results only carry the id;
-- sync_id is kept when the write result has it.
--
-- user_id is the first author and is NULL when the observation was created
-- before attribution or directly through engram (never guessed).
-- last_writer_id is whoever wrote it last through the gateway. Times are
-- epoch ms; first_written_at is NULL when the first write is unknown.
-- A row is removed when the observation is deleted through the gateway.

CREATE TABLE observation_authors (
  brain_id TEXT NOT NULL,
  observation_id INTEGER NOT NULL,
  sync_id TEXT,
  user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  last_writer_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  first_written_at INTEGER,
  last_written_at INTEGER NOT NULL,
  PRIMARY KEY (brain_id, observation_id)
) STRICT;
