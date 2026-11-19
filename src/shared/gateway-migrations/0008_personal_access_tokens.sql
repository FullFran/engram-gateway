-- Personal access tokens (#7). A PAT is a `token` connection (#27): its
-- brains and per-brain role live in connection_brains (scope `read` gives
-- reader, `read+write` writer), so the effective role is the weaker of the
-- owner's grant and the token's role, checked on every call.
--
-- `hash` is the SHA-256 of the secret (`egw_pat_` + 256 random bits); the
-- secret itself is shown once and never written. A revoked token keeps its
-- row (and its connection) so a later use is recognised and audited.
-- last_used_at is updated at most once a minute. Times in epoch seconds.
CREATE TABLE personal_access_tokens (
  id INTEGER PRIMARY KEY,
  connection_id INTEGER NOT NULL UNIQUE REFERENCES connections (id) ON DELETE CASCADE,
  hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'read+write')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
) STRICT;
