-- Connections (#27): a named client credential owned by a user (ChatGPT, a
-- code project, a CI job), with its own role on each brain it may use. The
-- effective role on a brain is the weaker of the owner's grant and the
-- connection's role, so a connection never exceeds its owner.
--
-- kind: 'oauth' connections come from the OAuth consent screen (one per
-- user and OAuth client); 'token' connections are issued for code projects
-- and CI (#7). default_brain_id is the brain a call naming none goes to.
CREATE TABLE connections (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('oauth', 'token')),
  client_id TEXT,
  default_brain_id INTEGER REFERENCES brains (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (user_id, name),
  CHECK ((kind = 'oauth') = (client_id IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX connections_oauth_client ON connections (user_id, client_id) WHERE kind = 'oauth';

CREATE TABLE connection_brains (
  connection_id INTEGER NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  brain_id INTEGER NOT NULL REFERENCES brains (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('reader', 'writer', 'owner')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (connection_id, brain_id)
) STRICT;

CREATE INDEX connection_brains_brain ON connection_brains (brain_id);

-- A token or code issued for a connection carries its id; NULL keeps the
-- single-brain meaning every token had before (brain from the resource).
-- Deleting a connection deletes its tokens and codes.
ALTER TABLE auth_codes ADD COLUMN connection_id INTEGER REFERENCES connections (id) ON DELETE CASCADE;
ALTER TABLE access_tokens ADD COLUMN connection_id INTEGER REFERENCES connections (id) ON DELETE CASCADE;
ALTER TABLE refresh_tokens ADD COLUMN connection_id INTEGER REFERENCES connections (id) ON DELETE CASCADE;

-- Authorship context (#21): the connection a write came through, for the
-- first write (with user_id) and the last one (with last_writer_id). NULL
-- for writes through a single-brain token or before connections existed.
ALTER TABLE observation_authors ADD COLUMN connection_id INTEGER REFERENCES connections (id) ON DELETE SET NULL;
ALTER TABLE observation_authors ADD COLUMN last_connection_id INTEGER REFERENCES connections (id) ON DELETE SET NULL;
