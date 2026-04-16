-- P5 #50 — Synthetic monitor scheduler tables

CREATE TABLE IF NOT EXISTS monitors (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  flow_config_json TEXT,
  cron_expression TEXT NOT NULL DEFAULT '*/15 * * * *',
  baseline_run_id TEXT,
  alert_webhook_url TEXT,
  alert_thresholds TEXT, -- JSON: {score_drop?, a11y_drop?, perf_drop?, visual_increase?, duration_threshold?}
  enabled INTEGER NOT NULL DEFAULT 1,
  paused_until TEXT,
  consecutive_fails INTEGER NOT NULL DEFAULT 0,
  last_run_id TEXT,
  last_run_at TEXT,
  last_alert_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_monitors_team ON monitors(team_id, enabled);

CREATE TABLE IF NOT EXISTS monitor_runs (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  http_status INTEGER,
  score REAL,
  regression INTEGER NOT NULL DEFAULT 0,
  alerted INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  summary_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_monitor_runs_monitor ON monitor_runs(monitor_id, created_at DESC);
