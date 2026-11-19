-- Subset of a real Engram engram.db schema (tables sessions, observations,
-- memory_relations and their indexes), copied verbatim from sqlite_schema.
-- The FTS tables and triggers are left out: the health report never reads them.
CREATE TABLE memory_relations (
			id                        INTEGER PRIMARY KEY AUTOINCREMENT,
			sync_id                   TEXT    NOT NULL UNIQUE,
			source_id                 TEXT,
			target_id                 TEXT,
			relation                  TEXT    NOT NULL DEFAULT 'pending',
			reason                    TEXT,
			evidence                  TEXT,
			confidence                REAL,
			judgment_status           TEXT    NOT NULL DEFAULT 'pending',
			marked_by_actor           TEXT,
			marked_by_kind            TEXT,
			marked_by_model           TEXT,
			session_id                TEXT,
			superseded_at             TEXT,
			superseded_by_relation_id INTEGER REFERENCES memory_relations(id) ON DELETE SET NULL,
			created_at                TEXT    NOT NULL DEFAULT (datetime('now')),
			updated_at                TEXT    NOT NULL DEFAULT (datetime('now'))
		);
CREATE TABLE observations (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT    NOT NULL,
			type       TEXT    NOT NULL,
			title      TEXT    NOT NULL,
			content    TEXT    NOT NULL,
			tool_name  TEXT,
			project    TEXT,
			scope      TEXT    NOT NULL DEFAULT 'project',
			topic_key  TEXT,
			normalized_hash TEXT,
			revision_count INTEGER NOT NULL DEFAULT 1,
			duplicate_count INTEGER NOT NULL DEFAULT 1,
			last_seen_at TEXT,
			created_at TEXT    NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
			deleted_at TEXT, sync_id TEXT, review_after TEXT, expires_at TEXT, embedding BLOB, embedding_model TEXT, embedding_created_at TEXT, pinned BOOLEAN NOT NULL DEFAULT 0, superseded_by_sync_id TEXT, org TEXT,
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		);
CREATE TABLE sessions (
			id         TEXT PRIMARY KEY,
			project    TEXT NOT NULL,
			directory  TEXT NOT NULL,
			started_at TEXT NOT NULL DEFAULT (datetime('now')),
			ended_at   TEXT,
			summary    TEXT
		, ownership_mode TEXT, runtime_lease_expires_at TEXT, local_creation_project TEXT);
CREATE INDEX idx_memrel_source    ON memory_relations(source_id, judgment_status);
CREATE INDEX idx_memrel_status_created
			ON memory_relations(judgment_status, created_at DESC);
CREATE INDEX idx_memrel_supersede ON memory_relations(superseded_by_relation_id);
CREATE INDEX idx_memrel_target    ON memory_relations(target_id, judgment_status);
CREATE INDEX idx_obs_created  ON observations(created_at DESC);
CREATE INDEX idx_obs_dedupe ON observations(normalized_hash, project, scope, type, title, created_at DESC);
CREATE INDEX idx_obs_deleted ON observations(deleted_at);
CREATE INDEX idx_obs_org ON observations(org);
CREATE INDEX idx_obs_project  ON observations(project);
CREATE INDEX idx_obs_project_lower ON observations(LOWER(project));
CREATE INDEX idx_obs_scope ON observations(scope);
CREATE INDEX idx_obs_session  ON observations(session_id);
CREATE INDEX idx_obs_sync_id ON observations(sync_id);
CREATE INDEX idx_obs_topic ON observations(topic_key, project, scope, updated_at DESC);
CREATE INDEX idx_obs_type     ON observations(type);
CREATE INDEX idx_sessions_project ON sessions(project);
CREATE INDEX idx_sessions_project_lower ON sessions(LOWER(project));
