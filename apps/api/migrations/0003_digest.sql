-- P5 #53 — Email digest preferences + log

CREATE TABLE IF NOT EXISTS digest_preferences (
  team_id TEXT PRIMARY KEY,
  frequency TEXT NOT NULL DEFAULT 'off', -- 'daily' | 'weekly' | 'off'
  recipients_json TEXT NOT NULL DEFAULT '[]',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS digest_log (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_digest_log_team ON digest_log(team_id, created_at DESC);
