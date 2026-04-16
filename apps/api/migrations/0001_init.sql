-- uxinspect API initial schema.
-- D1 runs on SQLite; all timestamps are epoch-seconds (INTEGER) unless noted.
-- IDs are opaque strings (ULID/KSUID/UUIDv7) generated at the edge, never rowid.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- teams: a workspace / billing unit. One license key == one team.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teams (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'free'
                CHECK (plan IN ('free', 'pro', 'team', 'enterprise')),
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'cancelled', 'past_due', 'revoked')),
  license_key_hash TEXT,
  polar_subscription_id TEXT,
  polar_customer_id TEXT,
  billing_email TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  renews_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_teams_polar_sub ON teams(polar_subscription_id);
CREATE INDEX IF NOT EXISTS idx_teams_plan ON teams(plan);

-- ---------------------------------------------------------------------------
-- members: users attached to a team with a role.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS members (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member'
              CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at  INTEGER NOT NULL,
  UNIQUE (team_id, email)
);
CREATE INDEX IF NOT EXISTS idx_members_team ON members(team_id);
CREATE INDEX IF NOT EXISTS idx_members_email ON members(email);

-- ---------------------------------------------------------------------------
-- api_keys: machine tokens for CLI / CI ingest. Stored as SHA-256 hash only.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  prefix      TEXT NOT NULL,               -- first 8 chars, for display
  key_hash    TEXT NOT NULL UNIQUE,        -- SHA-256 hex of the raw token
  scopes      TEXT NOT NULL DEFAULT 'ingest',
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_keys_team ON api_keys(team_id);

-- ---------------------------------------------------------------------------
-- flows: a named user journey (e.g. "checkout", "signup"). Optional grouping.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS flows (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (team_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_flows_team ON flows(team_id);

-- ---------------------------------------------------------------------------
-- runs: a single CLI run result. Large fields stored as JSON text (TEXT).
-- Heavy artifacts (replays, screenshots) live in R2 and referenced by URL.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,
  team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  flow_id         TEXT REFERENCES flows(id) ON DELETE SET NULL,
  target_url      TEXT NOT NULL,
  status          TEXT NOT NULL
                  CHECK (status IN ('pass', 'fail', 'partial', 'error')),
  score           REAL,                   -- 0..100 composite score
  a11y_score      REAL,
  perf_score      REAL,
  visual_diff     REAL,                   -- 0..1, lower is closer to baseline
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  user_agent      TEXT,
  viewport        TEXT,                   -- JSON { w, h }
  git_sha         TEXT,
  branch          TEXT,
  ci_url          TEXT,
  summary_json    TEXT NOT NULL,          -- full CLI run JSON, size-capped
  created_at      INTEGER NOT NULL,
  created_by_api_key TEXT REFERENCES api_keys(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_team_created ON runs(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_flow ON runs(flow_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(team_id, status);

-- ---------------------------------------------------------------------------
-- replays: rrweb blob metadata. Blob bytes live in R2 at r2_key.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS replays (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
  r2_key      TEXT NOT NULL UNIQUE,
  byte_size   INTEGER NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/json',
  sha256      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_replays_team ON replays(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_replays_run ON replays(run_id);

-- ---------------------------------------------------------------------------
-- audits: append-only activity log (login, plan change, key create/revoke).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audits (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  actor_email TEXT,
  action      TEXT NOT NULL,
  target_kind TEXT,
  target_id   TEXT,
  metadata    TEXT,                       -- JSON
  ip          TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audits_team_created ON audits(team_id, created_at DESC);
