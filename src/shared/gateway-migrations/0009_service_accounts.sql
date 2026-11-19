-- Service accounts (#7): non-human principals created by an instance admin
-- (owner_user_id), with their own API grants and personal access tokens.
-- They can never sign in through OAuth and are never instance admins.
ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'human' CHECK (kind IN ('human', 'service'));
ALTER TABLE users ADD COLUMN owner_user_id INTEGER REFERENCES users (id);
