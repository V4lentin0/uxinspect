-- P7 #63 — RUM ingest tables

CREATE TABLE IF NOT EXISTS site_tokens (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  site_id TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_site_tokens_site ON site_tokens(site_id);

CREATE TABLE IF NOT EXISTS rum_events (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  page_url TEXT,
  data_json TEXT,
  ip_anon TEXT,
  event_hash TEXT,
  timestamp INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rum_events_session ON rum_events(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_rum_events_site ON rum_events(site_id, type, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rum_events_dedup ON rum_events(event_hash);

CREATE TABLE IF NOT EXISTS rum_sessions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  started_at TEXT,
  last_event_at TEXT,
  page_count INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  replay_r2_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rum_sessions_site ON rum_sessions(site_id, last_event_at DESC);

CREATE TABLE IF NOT EXISTS rum_daily_usage (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day)
);
