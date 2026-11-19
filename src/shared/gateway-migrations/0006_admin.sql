-- Admin API (#10).
-- Grant ownership: `config` rows come from ALLOWED_GITHUB_LOGINS (owner of
-- every brain) and BRAIN_GRANTS and are rewritten on every start; `api` rows
-- are created by the admin API or CLI and survive restarts.
ALTER TABLE grants ADD COLUMN source TEXT NOT NULL DEFAULT 'config' CHECK (source IN ('config', 'api'));
-- An archived brain is not served (no child, no new session) but keeps its
-- row, its grants and its data directory on disk.
ALTER TABLE brains ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived'));
-- users.status (0001) takes 'invited' (created by an admin, activated by the
-- first successful sign-in), 'active' and 'disabled'.
