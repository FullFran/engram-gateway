-- Append-only audit log (#8). One row per tool call or admin action: who,
-- which brain, what, outcome and timing. Never memory content, argument
-- values or secrets: meta_json holds counts and ids only. Times in epoch ms.
--
-- actor_id is opaque: for users it is users.id, and the login lives in
-- `users`, so anonymising a user means editing `users`, not this log.
-- brain_id is an opaque text key (the brain slug) and is NULL when a call is
-- not tied to a brain.

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at_ms INTEGER NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'system')),
  actor_id TEXT NOT NULL,
  brain_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'error', 'denied')),
  duration_ms INTEGER,
  meta_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX audit_log_at ON audit_log (at_ms);
CREATE INDEX audit_log_brain_at ON audit_log (brain_id, at_ms);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
