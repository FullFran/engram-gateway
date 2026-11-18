-- Per-brain opt-in for Engram Cloud sync: ENGRAM_CLOUD_* reach a brain's
-- engram child only when this flag is 1. Off by default.
ALTER TABLE brains ADD COLUMN cloud_sync INTEGER NOT NULL DEFAULT 0;
