-- Gateway state, version 1. Token, code and secret columns hold SHA-256
-- hashes only; raw values are never written. Times are epoch seconds unless
-- the column name ends in _ms.

CREATE TABLE gateway_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- OAuth clients registered through DCR; `record` is the RegisteredClient as JSON.
CREATE TABLE clients (
  client_id TEXT PRIMARY KEY,
  record TEXT NOT NULL
) STRICT;

-- One refresh-token family per authorization code grant. A family revoked
-- before it was created (a replay won the race) is a tombstone row.
CREATE TABLE token_families (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;

CREATE TABLE access_tokens (
  hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  login TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  family_id TEXT NOT NULL
) STRICT;
CREATE INDEX access_tokens_family ON access_tokens (family_id);

CREATE TABLE refresh_tokens (
  hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  login TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  family_id TEXT NOT NULL,
  used_at INTEGER
) STRICT;
CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);

CREATE TABLE auth_codes (
  hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  login TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  family_id TEXT
) STRICT;

-- Single-use keys (consent tickets) and when they may be forgotten.
CREATE TABLE used_once (
  key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
) STRICT;

-- GitHub device logins by browser nonce; `record` is the DeviceLoginRecord as JSON.
CREATE TABLE device_logins (
  nonce TEXT PRIMARY KEY,
  expires_at_ms INTEGER NOT NULL,
  record TEXT NOT NULL
) STRICT;

-- Base for multi-brain access control (roles and their checks come with grants).
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  github_login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE TABLE brains (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  data_dir TEXT NOT NULL,
  semantic_search_enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE TABLE grants (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  brain_id INTEGER NOT NULL REFERENCES brains (id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, brain_id)
) STRICT;
CREATE INDEX grants_brain ON grants (brain_id);
