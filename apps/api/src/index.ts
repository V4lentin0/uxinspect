// uxinspect API worker. Pure Fetch router (no Hono dependency).
//
// Routes:
//   GET  /                        health text
//   POST /v1/ingest               upload CLI run JSON -> D1 (team-scoped)
//   POST /v1/replays              upload rrweb JSON -> R2, index in D1
//   GET  /v1/replays/:id          download replay blob
//   GET  /v1/runs                 list recent runs for team (cursor pagination)
//   GET  /v1/runs/:id             single run detail
//   GET  /v1/teams/:slug          team info (plan, member count, usage)
//   POST /webhooks/polar          billing events (plan up/down/cancel)
//
// All /v1/* endpoints require auth + apply per-plan rate limits.
// Webhook route bypasses auth but verifies HMAC signature inline.

import { authenticate, AuthContext, AuthError } from './auth.js';
import {
  ensureTeam,
  getReplayById,
  getRunById,
  getTeamBySlug,
  insertAudit,
  insertReplay,
  insertRun,
  listRuns,
  newId,
} from './db.js';
import { getReplayBlob, putReplayBlob } from './r2.js';
import { checkAndConsume, rateLimitHeaders } from './ratelimit.js';
import type { Env } from './types.js';
import { handlePolarWebhook } from './webhooks.js';
import { handleScheduled } from './scheduled.js';
import { generateOpenApiSpec } from './openapi.js';

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // CORS preflight -- respond for all routes before anything else.
    if (req.method === 'OPTIONS') return preflight(req, env);

    try {
      if (req.method === 'GET' && path === '/') return text('uxinspect api ok', 200, corsHeaders(req, env));

      if (req.method === 'POST' && path === '/webhooks/polar') {
        return withCors(await handlePolarWebhook(req, env), req, env);
      }

      // Authenticated v1 surface
      if (path.startsWith('/v1/')) {
        const auth = await authenticate(req, env);
        await ensureTeam(env, { id: auth.teamId, email: auth.email, plan: auth.plan, slug: auth.teamSlug });

        const rl = await checkAndConsume(env, auth.teamId, auth.plan);
        if (!rl.allowed) {
          return jsonResp(
            { ok: false, error: 'rate_limited', limit: rl.limit, resetAt: rl.resetAt },
            429,
            { ...rateLimitHeaders(rl), ...corsHeaders(req, env) },
          );
        }
        const baseHeaders = { ...rateLimitHeaders(rl), ...corsHeaders(req, env) };

        if (req.method === 'POST' && path === '/v1/ingest') return ingestRun(req, env, auth, baseHeaders, ctx);
        if (req.method === 'POST' && path === '/v1/replays') return uploadReplay(req, env, auth, baseHeaders);
        if (req.method === 'GET' && path === '/v1/runs') return handleListRuns(url, env, auth, baseHeaders);
        const runMatch = /^\/v1\/runs\/([A-Za-z0-9_-]+)$/.exec(path);
        if (req.method === 'GET' && runMatch) {
          return handleGetRun(runMatch[1], env, auth, baseHeaders);
        }
        const replayMatch = /^\/v1\/replays\/([A-Za-z0-9_-]+)$/.exec(path);
        if (req.method === 'GET' && replayMatch) {
          return handleGetReplay(replayMatch[1], env, auth, baseHeaders);
        }
        const teamMatch = /^\/v1\/teams\/([A-Za-z0-9_-]+)$/.exec(path);
        if (req.method === 'GET' && teamMatch) {
          return handleGetTeam(teamMatch[1], env, auth, baseHeaders);
        }

        // P5 #48 — multi-repo endpoints
        if (req.method === 'GET' && path === '/v1/repos') {
          return handleListRepos(env, auth, baseHeaders);
        }
        const repoMatch = /^\/v1\/repos\/([A-Za-z0-9_.-]+)$/.exec(path);
        if (req.method === 'GET' && repoMatch) {
          return handleGetRepo(repoMatch[1], env, auth, baseHeaders);
        }

        // P6 #58 — Extended REST API
        if (req.method === 'GET' && path === '/v1/flows') {
          return handleListFlows(env, auth, baseHeaders);
        }
        if (req.method === 'GET' && path === '/v1/anomalies') {
          return handleListAnomalies(env, auth, baseHeaders);
        }
        if (req.method === 'GET' && path === '/v1/coverage') {
          return handleCoverage(env, auth, baseHeaders);
        }
        if (req.method === 'GET' && path === '/v1/openapi.json') {
          return jsonResp(generateOpenApiSpec(), 200, baseHeaders);
        }
        if (req.method === 'DELETE' && runMatch) {
          return handleDeleteRun(runMatch[1], env, auth, baseHeaders);
        }
      }

      return jsonResp({ ok: false, error: 'not_found' }, 404, corsHeaders(req, env));
    } catch (err) {
      if (err instanceof AuthError) {
        return jsonResp({ ok: false, error: err.code }, err.status, corsHeaders(req, env));
      }
      // Sanitise outgoing error text: no stack traces, no vendor names.
      const message = err instanceof Error ? err.message : 'internal_error';
      console.error('api_error', message);
      return jsonResp({ ok: false, error: 'internal_error' }, 500, corsHeaders(req, env));
    }
  },

  // P5 #50 — Synthetic monitor cron
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(event, env));
  },
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

interface IngestPayload {
  flow?: { slug?: string; name?: string };
  target_url?: string;
  targetUrl?: string;
  status?: 'pass' | 'fail' | 'partial' | 'error';
  score?: number;
  scores?: { a11y?: number; perf?: number; visual_diff?: number };
  duration_ms?: number;
  durationMs?: number;
  user_agent?: string;
  viewport?: { w?: number; h?: number };
  git?: { sha?: string; branch?: string };
  ci?: { url?: string };
  replay_id?: string;
  summary?: unknown;
  [k: string]: unknown;
}

async function ingestRun(
  req: Request,
  env: Env,
  auth: AuthContext,
  headers: Record<string, string>,
  ctx: ExecutionContext,
): Promise<Response> {
  const maxBytes = parseInt(env.INGEST_MAX_BYTES || '10485760', 10);
  const len = parseInt(req.headers.get('content-length') || '0', 10);
  if (len > maxBytes) return jsonResp({ ok: false, error: 'payload_too_large', maxBytes }, 413, headers);

  const raw = await req.text();
  if (raw.length > maxBytes) return jsonResp({ ok: false, error: 'payload_too_large', maxBytes }, 413, headers);

  let payload: IngestPayload;
  try {
    payload = JSON.parse(raw) as IngestPayload;
  } catch {
    return jsonResp({ ok: false, error: 'invalid_json' }, 400, headers);
  }

  const targetUrl = (payload.target_url ?? payload.targetUrl ?? '').toString().trim();
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    return jsonResp({ ok: false, error: 'invalid_target_url' }, 400, headers);
  }

  const status = payload.status && ['pass', 'fail', 'partial', 'error'].includes(payload.status)
    ? payload.status
    : 'error';

  // Optional flow resolution: upsert by slug if present.
  let flowId: string | null = null;
  if (payload.flow?.slug) {
    const slug = payload.flow.slug.slice(0, 64).replace(/[^a-z0-9_-]/gi, '').toLowerCase();
    if (slug) flowId = await upsertFlow(env, auth.teamId, slug, payload.flow.name ?? slug);
  }

  const durationMs = Number.isFinite(payload.duration_ms)
    ? Number(payload.duration_ms)
    : Number.isFinite(payload.durationMs)
      ? Number(payload.durationMs)
      : 0;

  const runId = await insertRun(env, {
    teamId: auth.teamId,
    flowId,
    targetUrl,
    status,
    score: numOrNull(payload.score),
    a11yScore: numOrNull(payload.scores?.a11y),
    perfScore: numOrNull(payload.scores?.perf),
    visualDiff: numOrNull(payload.scores?.visual_diff),
    durationMs: Math.max(0, Math.floor(durationMs)),
    userAgent: strOrNull(payload.user_agent, 512),
    viewport: payload.viewport ? JSON.stringify(payload.viewport).slice(0, 256) : null,
    gitSha: strOrNull(payload.git?.sha, 64),
    branch: strOrNull(payload.git?.branch, 256),
    ciUrl: strOrNull(payload.ci?.url, 1024),
    summaryJson: raw,
    apiKeyId: auth.apiKeyId ?? null,
  });

  // Audit is best-effort; don't block the ingest response.
  ctx.waitUntil(
    insertAudit(env, {
      teamId: auth.teamId,
      actorEmail: auth.email ?? null,
      action: 'run.ingest',
      targetKind: 'run',
      targetId: runId,
      metadata: { status, targetUrl },
      ip: req.headers.get('cf-connecting-ip'),
    }).catch(() => {}),
  );

  return jsonResp({ ok: true, run: { id: runId, status, target_url: targetUrl } }, 201, headers);
}

async function uploadReplay(
  req: Request,
  env: Env,
  auth: AuthContext,
  headers: Record<string, string>,
): Promise<Response> {
  const maxBytes = parseInt(env.REPLAY_MAX_BYTES || '52428800', 10);
  const declaredLen = parseInt(req.headers.get('content-length') || '0', 10);
  if (declaredLen > maxBytes) {
    return jsonResp({ ok: false, error: 'payload_too_large', maxBytes }, 413, headers);
  }

  const runId = new URL(req.url).searchParams.get('run_id');
  const contentType = req.headers.get('content-type') || 'application/json';
  const body = await req.arrayBuffer();
  if (body.byteLength === 0) return jsonResp({ ok: false, error: 'empty_body' }, 400, headers);
  if (body.byteLength > maxBytes) {
    return jsonResp({ ok: false, error: 'payload_too_large', maxBytes }, 413, headers);
  }

  // Cheap JSON sanity check for the default path.
  if (contentType.includes('application/json')) {
    try {
      JSON.parse(new TextDecoder().decode(body));
    } catch {
      return jsonResp({ ok: false, error: 'invalid_json' }, 400, headers);
    }
  }

  const replayId = newId('rep');
  const put = await putReplayBlob(env, {
    teamId: auth.teamId,
    replayId,
    body,
    contentType,
  });

  const id = await insertReplay(env, {
    teamId: auth.teamId,
    runId: runId && /^[A-Za-z0-9_-]+$/.test(runId) ? runId : null,
    r2Key: put.r2Key,
    byteSize: put.byteSize,
    contentType: put.contentType,
    sha256: put.sha256,
  });

  const downloadUrl = `https://${new URL(req.url).host}/v1/replays/${id}`;
  return jsonResp(
    {
      ok: true,
      replay: {
        id,
        byte_size: put.byteSize,
        sha256: put.sha256,
        url: downloadUrl,
      },
    },
    201,
    headers,
  );
}

async function handleListRuns(
  url: URL,
  env: Env,
  auth: AuthContext,
  headers: Record<string, string>,
): Promise<Response> {
  const limit = parseInt(url.searchParams.get('limit') || '20', 10);
  const cursorRaw = url.searchParams.get('cursor');
  const cursor = cursorRaw ? parseInt(cursorRaw, 10) : undefined;
  const status = url.searchParams.get('status') || undefined;
  const flowId = url.searchParams.get('flow_id') || undefined;

  const { rows, nextCursor } = await listRuns(env, auth.teamId, {
    limit: Number.isFinite(limit) ? limit : 20,
    cursor: Number.isFinite(cursor as number) ? cursor : undefined,
    status,
    flowId,
  });

  return jsonResp(
    {
      ok: true,
      runs: rows,
      pagination: { next_cursor: nextCursor },
    },
    200,
    headers,
  );
}

async function handleGetRun(
  id: string,
  env: Env,
  auth: AuthContext,
  headers: Record<string, string>,
): Promise<Response> {
  const run = await getRunById(env, auth.teamId, id);
  if (!run) return jsonResp({ ok: false, error: 'not_found' }, 404, headers);
  let summary: unknown = null;
  try {
    summary = JSON.parse(run.summary_json);
  } catch {
    summary = null;
  }
  const { summary_json, ...rest } = run;
  return jsonResp({ ok: true, run: { ...rest, summary } }, 200, headers);
}

async function handleGetReplay(
  id: string,
  env: Env,
  auth: AuthContext,
  headers: Record<string, string>,
): Promise<Response> {
  const row = await getReplayById(env, auth.teamId, id);
  if (!row) return jsonResp({ ok: false, error: 'not_found' }, 404, headers);
  const obj = await getReplayBlob(env, row.r2_key);
  if (!obj) return jsonResp({ ok: false, error: 'blob_missing' }, 410, headers);
  return new Response(obj.body, {
    status: 200,
    headers: {
      ...headers,
      'content-type': row.content_type,
      'content-length': String(row.byte_size),
      'cache-control': 'private, max-age=3600',
      etag: row.sha256 ? `"${row.sha256}"` : '',
    },
  });
}

async function handleGetTeam(
  slug: string,
  env: Env,
  auth: AuthContext,
  headers: Record<string, string>,
): Promise<Response> {
  const team = await getTeamBySlug(env, slug);
  if (!team) return jsonResp({ ok: false, error: 'not_found' }, 404, headers);
  if (team.id !== auth.teamId) return jsonResp({ ok: false, error: 'forbidden' }, 403, headers);

  // Lightweight usage: runs in last 24h + total replays + members.
  const since = Math.floor(Date.now() / 1000) - 86400;
  const usage = await env.UXINSPECT_DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM runs WHERE team_id = ?1 AND created_at >= ?2) AS runs_24h,
       (SELECT COUNT(*) FROM runs WHERE team_id = ?1) AS runs_total,
       (SELECT COUNT(*) FROM replays WHERE team_id = ?1) AS replays_total,
       (SELECT COUNT(*) FROM members WHERE team_id = ?1) AS members_total`,
  )
    .bind(team.id, since)
    .first<{ runs_24h: number; runs_total: number; replays_total: number; members_total: number }>();

  return jsonResp(
    {
      ok: true,
      team: {
        id: team.id,
        slug: team.slug,
        name: team.name,
        plan: team.plan,
        status: team.status,
        renews_at: team.renews_at,
        created_at: team.created_at,
      },
      usage,
    },
    200,
    headers,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function upsertFlow(env: Env, teamId: string, slug: string, name: string): Promise<string> {
  const existing = await env.UXINSPECT_DB.prepare(
    `SELECT id FROM flows WHERE team_id = ?1 AND slug = ?2 LIMIT 1`,
  )
    .bind(teamId, slug)
    .first<{ id: string }>();
  if (existing?.id) return existing.id;
  const id = newId('flow');
  const ts = Math.floor(Date.now() / 1000);
  await env.UXINSPECT_DB.prepare(
    `INSERT INTO flows (id, team_id, slug, name, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
  )
    .bind(id, teamId, slug, name.slice(0, 128), ts)
    .run();
  return id;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGIN || 'https://app.uxinspect.com';
  const origin = req.headers.get('origin');
  const allow = origin && originMatches(origin, allowed) ? origin : allowed;
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-credentials': 'true',
    'access-control-expose-headers': 'x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset',
    vary: 'origin',
  };
}

function originMatches(origin: string, allowed: string): boolean {
  if (!allowed) return false;
  if (allowed === '*') return true;
  const list = allowed.split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(origin);
}

function preflight(req: Request, env: Env): Response {
  const headers: Record<string, string> = {
    ...corsHeaders(req, env),
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': req.headers.get('access-control-request-headers')
      ?? 'authorization, content-type, x-uxinspect-key, x-api-key',
    'access-control-max-age': '86400',
  };
  return new Response(null, { status: 204, headers });
}

function withCors(resp: Response, req: Request, env: Env): Response {
  const headers = new Headers(resp.headers);
  const extra = corsHeaders(req, env);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, headers });
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function text(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...extra },
  });
}

function jsonResp(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

// ---------------------------------------------------------------------------
// P5 #48 — Multi-repo endpoints
// ---------------------------------------------------------------------------

async function handleListRepos(
  env: Env,
  auth: AuthContext,
  headers: Record<string, string>,
): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT target_url AS url,
            COUNT(*) AS total_runs,
            SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) AS pass_count,
            MAX(created_at) AS last_run_at,
            AVG(score) AS avg_score
     FROM runs
     WHERE team_id = ?1 AND deleted = 0
     GROUP BY target_url
     ORDER BY last_run_at DESC
     LIMIT 100`,
  ).bind(auth.teamId).all();

  const repos = (rows.results ?? []).map((r: any) => ({
    url: r.url,
    name: repoName(r.url as string),
    totalRuns: r.total_runs,
    passRate: r.total_runs > 0 ? Math.round(((r.pass_count ?? 0) / r.total_runs) * 100) : 0,
    lastRunAt: r.last_run_at,
    avgScore: r.avg_score != null ? Math.round(r.avg_score * 100) / 100 : null,
  }));

  return jsonResp({ ok: true, repos }, 200, headers);
}

async function handleGetRepo(
  repoId: string,
  env: Env,
  auth: AuthContext,
  headers: Record<string, string>,
): Promise<Response> {
  const decodedUrl = decodeURIComponent(repoId);
  const rows = await env.DB.prepare(
    `SELECT id, status, score, duration_ms, created_at, flow_slug, viewport_w, viewport_h
     FROM runs
     WHERE team_id = ?1 AND target_url = ?2 AND deleted = 0
     ORDER BY created_at DESC
     LIMIT 50`,
  ).bind(auth.teamId, decodedUrl).all();

  return jsonResp({
    ok: true,
    url: decodedUrl,
    name: repoName(decodedUrl),
    runs: rows.results ?? [],
  }, 200, headers);
}

function repoName(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// P6 #58 — Extended REST API handlers
// ---------------------------------------------------------------------------

async function handleListFlows(
  env: Env, auth: AuthContext, headers: Record<string, string>,
): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT flow_slug AS name, COUNT(*) AS run_count,
            SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) AS pass_count,
            MAX(created_at) AS last_run_at
     FROM runs WHERE team_id = ?1 AND deleted = 0 AND flow_slug IS NOT NULL
     GROUP BY flow_slug ORDER BY last_run_at DESC LIMIT 200`,
  ).bind(auth.teamId).all();
  return jsonResp({ ok: true, flows: rows.results ?? [] }, 200, headers);
}

async function handleListAnomalies(
  env: Env, auth: AuthContext, headers: Record<string, string>,
): Promise<Response> {
  // Return recent runs with score anomalies (z-score computed client-side for now)
  const rows = await env.DB.prepare(
    `SELECT id, flow_slug, score, duration_ms, created_at
     FROM runs WHERE team_id = ?1 AND deleted = 0
     ORDER BY created_at DESC LIMIT 100`,
  ).bind(auth.teamId).all();
  return jsonResp({ ok: true, runs: rows.results ?? [] }, 200, headers);
}

async function handleCoverage(
  env: Env, auth: AuthContext, headers: Record<string, string>,
): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT target_url AS route, COUNT(DISTINCT flow_slug) AS flows_tested
     FROM runs WHERE team_id = ?1 AND deleted = 0
     GROUP BY target_url ORDER BY flows_tested DESC LIMIT 200`,
  ).bind(auth.teamId).all();
  return jsonResp({ ok: true, coverage: rows.results ?? [] }, 200, headers);
}

async function handleDeleteRun(
  runId: string, env: Env, auth: AuthContext, headers: Record<string, string>,
): Promise<Response> {
  await env.DB.prepare(
    `UPDATE runs SET deleted = 1 WHERE id = ?1 AND team_id = ?2`,
  ).bind(runId, auth.teamId).run();
  return jsonResp({ ok: true, deleted: runId }, 200, headers);
}
