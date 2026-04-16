// Shared types & env shape for the uxinspect API worker.

export type Plan = 'free' | 'pro' | 'team' | 'enterprise';
export type TeamStatus = 'active' | 'cancelled' | 'past_due' | 'revoked';

export interface Env {
  DB: D1Database;
  UXINSPECT_DB: D1Database;
  REPLAYS: R2Bucket;
  UXINSPECT_REPLAYS: R2Bucket;
  UXINSPECT_CACHE: KVNamespace;

  // Secrets
  POLAR_WEBHOOK_SECRET: string;
  JWT_PUBLIC_KEY: string;
  POLAR_API_TOKEN?: string;

  // Vars
  ALLOWED_ORIGIN: string;
  JWT_ISSUER: string;
  REPLAY_MAX_BYTES: string;
  INGEST_MAX_BYTES: string;

  // P5 #53 email digest
  EMAIL_API_URL?: string;
  EMAIL_API_KEY?: string;
  EMAIL_FROM?: string;
}

export interface TeamRow {
  id: string;
  slug: string;
  name: string;
  plan: Plan;
  status: TeamStatus;
  license_key_hash: string | null;
  polar_subscription_id: string | null;
  polar_customer_id: string | null;
  billing_email: string | null;
  created_at: number;
  updated_at: number;
  renews_at: number | null;
}

export interface RunRow {
  id: string;
  team_id: string;
  flow_id: string | null;
  target_url: string;
  status: 'pass' | 'fail' | 'partial' | 'error';
  score: number | null;
  a11y_score: number | null;
  perf_score: number | null;
  visual_diff: number | null;
  duration_ms: number;
  user_agent: string | null;
  viewport: string | null;
  git_sha: string | null;
  branch: string | null;
  ci_url: string | null;
  summary_json: string;
  created_at: number;
  created_by_api_key: string | null;
}

export interface ReplayRow {
  id: string;
  team_id: string;
  run_id: string | null;
  r2_key: string;
  byte_size: number;
  content_type: string;
  sha256: string | null;
  created_at: number;
}
