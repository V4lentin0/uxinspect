// Thin D1 query helpers. All queries are team-scoped at the call site.

import type { Env, Plan, ReplayRow, RunRow, TeamRow, TeamStatus } from './types.js';

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

// ULID-ish: 10 chars ts (base32) + 16 chars random (base32). 26 chars total.
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newId(prefix?: string): string {
  const t = Date.now();
  let tsPart = '';
  let v = t;
  for (let i = 0; i < 10; i++) {
    tsPart = ULID_ALPHABET[v % 32] + tsPart;
    v = Math.floor(v / 32);
  }
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  let randPart = '';
  for (let i = 0; i < 16; i++) {
    randPart += ULID_ALPHABET[rand[i % rand.length] % 32];
  }
  const id = `${tsPart}${randPart}`;
  return prefix ? `${prefix}_${id}` : id;
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------
export async function getTeamById(env: Env, id: string): Promise<TeamRow | null> {
  return env.UXINSPECT_DB.prepare(`SELECT * FROM teams WHERE id = ?1 LIMIT 1`)
    .bind(id)
    .first<TeamRow>();
}

export async function getTeamBySlug(env: Env, slug: string): Promise<TeamRow | null> {
  return env.UXINSPECT_DB.prepare(`SELECT * FROM teams WHERE slug = ?1 LIMIT 1`)
    .bind(slug)
    .first<TeamRow>();
}

export async function ensureTeam(
  env: Env,
  opts: { id: string; email?: string; plan: Plan; status?: TeamStatus; slug?: string },
): Promise<TeamRow> {
  const existing = await getTeamById(env, opts.id);
  if (existing) return existing;
  const ts = now();
  const slug = opts.slug ?? slugFromId(opts.id);
  const name = opts.email?.split('@')[0] ?? slug;
  await env.UXINSPECT_DB.prepare(
    `INSERT INTO teams (id, slug, name, plan, status, billing_email, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
  )
    .bind(opts.id, slug, name, opts.plan, opts.status ?? 'active', opts.email ?? null, ts)
    .run();
  return (await getTeamById(env, opts.id))!;
}

function slugFromId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 48) || 'team';
}

export async function updateTeamFromPolar(
  env: Env,
  opts: {
    subscriptionId: string;
    plan: Plan;
    status: TeamStatus;
    renewsAt: number | null;
    email?: string;
    customerId?: string;
  },
): Promise<void> {
  const ts = now();
  const existing = await env.UXINSPECT_DB.prepare(
    `SELECT * FROM teams WHERE polar_subscription_id = ?1 LIMIT 1`,
  )
    .bind(opts.subscriptionId)
    .first<TeamRow>();

  if (existing) {
    await env.UXINSPECT_DB.prepare(
      `UPDATE teams
          SET plan = ?1,
              status = ?2,
              renews_at = ?3,
              billing_email = COALESCE(?4, billing_email),
              polar_customer_id = COALESCE(?5, polar_customer_id),
              updated_at = ?6
        WHERE id = ?7`,
    )
      .bind(opts.plan, opts.status, opts.renewsAt, opts.email ?? null, opts.customerId ?? null, ts, existing.id)
      .run();
    return;
  }

  // Brand-new team from webhook before the user has ever hit the API.
  const id = newId('team');
  const slug = slugFromId(id);
  await env.UXINSPECT_DB.prepare(
    `INSERT INTO teams
       (id, slug, name, plan, status, polar_subscription_id, polar_customer_id, billing_email,
        renews_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
  )
    .bind(
      id,
      slug,
      opts.email?.split('@')[0] ?? slug,
      opts.plan,
      opts.status,
      opts.subscriptionId,
      opts.customerId ?? null,
      opts.email ?? null,
      opts.renewsAt,
      ts,
    )
    .run();
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------
export interface InsertRunInput {
  teamId: string;
  flowId: string | null;
  targetUrl: string;
  status: 'pass' | 'fail' | 'partial' | 'error';
  score: number | null;
  a11yScore: number | null;
  perfScore: number | null;
  visualDiff: number | null;
  durationMs: number;
  userAgent: string | null;
  viewport: string | null;
  gitSha: string | null;
  branch: string | null;
  ciUrl: string | null;
  summaryJson: string;
  apiKeyId: string | null;
}

export async function insertRun(env: Env, input: InsertRunInput): Promise<string> {
  const id = newId('run');
  await env.UXINSPECT_DB.prepare(
    `INSERT INTO runs
       (id, team_id, flow_id, target_url, status, score, a11y_score, perf_score, visual_diff,
        duration_ms, user_agent, viewport, git_sha, branch, ci_url, summary_json,
        created_at, created_by_api_key)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
  )
    .bind(
      id,
      input.teamId,
      input.flowId,
      input.targetUrl,
      input.status,
      input.score,
      input.a11yScore,
      input.perfScore,
      input.visualDiff,
      input.durationMs,
      input.userAgent,
      input.viewport,
      input.gitSha,
      input.branch,
      input.ciUrl,
      input.summaryJson,
      now(),
      input.apiKeyId,
    )
    .run();
  return id;
}

export async function listRuns(
  env: Env,
  teamId: string,
  opts: { limit: number; cursor?: number; status?: string; flowId?: string },
): Promise<{ rows: Partial<RunRow>[]; nextCursor: number | null }> {
  const limit = Math.min(Math.max(1, opts.limit), 100);
  const cursor = opts.cursor ?? Number.MAX_SAFE_INTEGER;
  const params: (string | number)[] = [teamId, cursor];
  let where = `team_id = ?1 AND created_at < ?2`;
  if (opts.status) {
    params.push(opts.status);
    where += ` AND status = ?${params.length}`;
  }
  if (opts.flowId) {
    params.push(opts.flowId);
    where += ` AND flow_id = ?${params.length}`;
  }
  params.push(limit + 1);
  const sql = `
    SELECT id, team_id, flow_id, target_url, status, score, a11y_score, perf_score,
           visual_diff, duration_ms, git_sha, branch, ci_url, created_at
      FROM runs
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT ?${params.length}`;
  const res = await env.UXINSPECT_DB.prepare(sql)
    .bind(...params)
    .all<Partial<RunRow>>();
  const rows = res.results ?? [];
  let nextCursor: number | null = null;
  if (rows.length > limit) {
    const last = rows[limit - 1];
    nextCursor = last?.created_at ?? null;
    rows.length = limit;
  }
  return { rows, nextCursor };
}

export async function getRunById(env: Env, teamId: string, id: string): Promise<RunRow | null> {
  return env.UXINSPECT_DB.prepare(
    `SELECT * FROM runs WHERE team_id = ?1 AND id = ?2 LIMIT 1`,
  )
    .bind(teamId, id)
    .first<RunRow>();
}

// ---------------------------------------------------------------------------
// Replays
// ---------------------------------------------------------------------------
export async function insertReplay(
  env: Env,
  opts: {
    teamId: string;
    runId: string | null;
    r2Key: string;
    byteSize: number;
    contentType: string;
    sha256: string | null;
  },
): Promise<string> {
  const id = newId('rep');
  await env.UXINSPECT_DB.prepare(
    `INSERT INTO replays (id, team_id, run_id, r2_key, byte_size, content_type, sha256, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(id, opts.teamId, opts.runId, opts.r2Key, opts.byteSize, opts.contentType, opts.sha256, now())
    .run();
  return id;
}

export async function getReplayById(env: Env, teamId: string, id: string): Promise<ReplayRow | null> {
  return env.UXINSPECT_DB.prepare(
    `SELECT * FROM replays WHERE team_id = ?1 AND id = ?2 LIMIT 1`,
  )
    .bind(teamId, id)
    .first<ReplayRow>();
}

// ---------------------------------------------------------------------------
// Audits
// ---------------------------------------------------------------------------
export async function insertAudit(
  env: Env,
  opts: {
    teamId: string;
    actorEmail?: string | null;
    action: string;
    targetKind?: string | null;
    targetId?: string | null;
    metadata?: unknown;
    ip?: string | null;
  },
): Promise<void> {
  await env.UXINSPECT_DB.prepare(
    `INSERT INTO audits (id, team_id, actor_email, action, target_kind, target_id, metadata, ip, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      newId('aud'),
      opts.teamId,
      opts.actorEmail ?? null,
      opts.action,
      opts.targetKind ?? null,
      opts.targetId ?? null,
      opts.metadata ? JSON.stringify(opts.metadata) : null,
      opts.ip ?? null,
      now(),
    )
    .run();
}
