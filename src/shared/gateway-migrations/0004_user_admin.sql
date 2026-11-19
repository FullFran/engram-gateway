-- Instance admins (#6): a flag on the user, not a brain role. Startup sets it
-- for exactly the logins in ALLOWED_GITHUB_LOGINS. Brain roles live in
-- `grants.role` (reader, writer, owner), checked by the gateway.
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1));
