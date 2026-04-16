/**
 * api.ts — typed fetch wrappers for api.uxinspect.com.
 *
 * All calls send credentials (httpOnly cookie) + optional bearer header
 * (fallback). Non-2xx responses throw `ApiError` with the structured
 * problem-json payload so the UI can branch on `status` / `code`.
 */

import { getBearerToken, clearSession } from './auth';

const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? 'https://api.uxinspect.com';

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface RequestInit2 extends Omit<RequestInit, 'body'> {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

async function request<T>(path: string, init: RequestInit2 = {}): Promise<T> {
  const url = new URL(path.startsWith('http') ? path : `${API_BASE}${path}`);
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const headers = new Headers(init.headers);
  const bearer = getBearerToken();
  if (bearer) headers.set('authorization', `Bearer ${bearer}`);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(url.toString(), {
    ...init,
    headers,
    credentials: 'include',
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 401) {
    clearSession();
  }
  const ct = res.headers.get('content-type') ?? '';
  const isJson = ct.includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const msg =
      (isJson && payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : typeof payload === 'string' && payload
          ? payload
          : res.statusText) || 'request failed';
    const code =
      isJson && payload && typeof payload === 'object' && 'code' in payload
        ? String((payload as { code: unknown }).code)
        : undefined;
    throw new ApiError(msg, res.status, code, payload);
  }
  return payload as T;
}

// ─── Auth ─────────────────────────────────────────────────────────────────

export interface MagicLinkResponse {
  sent: boolean;
  expiresAt: number;
}

export interface ConfirmResponse {
  user: { id: string; email: string };
  teams: Team[];
  /** When the API can't set an httpOnly cookie it returns a bearer in the body. */
  token?: string;
  expiresAt: number;
}

export const auth = {
  requestMagicLink: (email: string) =>
    request<MagicLinkResponse>('/auth/magic-link', {
      method: 'POST',
      body: { email },
    }),
  confirmMagicLink: (token: string) =>
    request<ConfirmResponse>('/auth/confirm', {
      method: 'POST',
      body: { token },
    }),
  signOut: () => request<{ ok: true }>('/auth/signout', { method: 'POST' }),
  me: () => request<{ user: { id: string; email: string }; teams: Team[] }>('/auth/me'),
};

// ─── Teams ────────────────────────────────────────────────────────────────

export interface Team {
  id: string;
  name: string;
  slug: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  plan: 'free' | 'pro' | 'team' | 'enterprise';
  createdAt: string;
}

export interface Member {
  id: string;
  email: string;
  role: Team['role'];
  invitedAt: string;
  joinedAt?: string;
  status: 'active' | 'invited' | 'suspended';
}

export interface ApiKey {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  /** Only returned once, on creation. */
  secret?: string;
}

export const teams = {
  list: () => request<Team[]>('/teams'),
  get: (teamId: string) => request<Team>(`/teams/${teamId}`),
  update: (teamId: string, patch: Partial<Pick<Team, 'name' | 'slug'>>) =>
    request<Team>(`/teams/${teamId}`, { method: 'PATCH', body: patch }),
  members: (teamId: string) => request<Member[]>(`/teams/${teamId}/members`),
  invite: (teamId: string, email: string, role: Team['role']) =>
    request<Member>(`/teams/${teamId}/members`, {
      method: 'POST',
      body: { email, role },
    }),
  removeMember: (teamId: string, memberId: string) =>
    request<{ ok: true }>(`/teams/${teamId}/members/${memberId}`, { method: 'DELETE' }),
  apiKeys: (teamId: string) => request<ApiKey[]>(`/teams/${teamId}/keys`),
  createApiKey: (teamId: string, label: string) =>
    request<ApiKey>(`/teams/${teamId}/keys`, { method: 'POST', body: { label } }),
  revokeApiKey: (teamId: string, keyId: string) =>
    request<{ ok: true }>(`/teams/${teamId}/keys/${keyId}`, { method: 'DELETE' }),
};

// ─── Runs ─────────────────────────────────────────────────────────────────

export interface RunSummary {
  id: string;
  url: string;
  status: 'passed' | 'failed' | 'running';
  startedAt: string;
  finishedAt?: string;
  durationMs: number;
  flowsTotal: number;
  flowsFailed: number;
  a11yViolations: number;
  visualFails: number;
  perfScore?: number;
  branch?: string;
  commit?: string;
  actor?: string;
}

export interface Flow {
  id: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  steps: {
    action: string;
    selector?: string;
    status: 'passed' | 'failed';
    error?: string;
    screenshot?: string;
  }[];
}

export interface Audit {
  type: 'a11y' | 'visual' | 'perf' | 'seo';
  url: string;
  score?: number;
  violations: {
    id: string;
    impact: 'minor' | 'moderate' | 'serious' | 'critical';
    description: string;
    nodes: number;
  }[];
}

export interface Heatmap {
  url: string;
  clicks: { x: number; y: number; n: number }[];
  width: number;
  height: number;
  screenshot?: string;
}

export interface ReplayRef {
  id: string;
  durationMs: number;
  flowName?: string;
  embedUrl: string;
  thumbnail?: string;
}

export interface RunDetail extends RunSummary {
  flows: Flow[];
  audits: Audit[];
  heatmaps: Heatmap[];
  replays: ReplayRef[];
  anomalies: Anomaly[];
}

export interface Anomaly {
  id: string;
  metric: string; // e.g. 'a11yViolations', 'perfScore', 'durationMs'
  severity: 'info' | 'warn' | 'fail';
  baseline: number;
  current: number;
  delta: number;
  message: string;
}

export const runs = {
  list: (teamId: string, opts: { limit?: number; cursor?: string } = {}) =>
    request<{ items: RunSummary[]; cursor?: string }>(`/teams/${teamId}/runs`, {
      query: { limit: opts.limit ?? 25, cursor: opts.cursor },
    }),
  get: (teamId: string, runId: string) =>
    request<RunDetail>(`/teams/${teamId}/runs/${runId}`),
  summary: (teamId: string) =>
    request<{
      total: number;
      passed: number;
      failed: number;
      running: number;
      a11yTotal: number;
      perfAvg: number | null;
      anomalies: Anomaly[];
    }>(`/teams/${teamId}/runs/summary`),
};

// ─── History / trends ────────────────────────────────────────────────────

export interface TrendPoint {
  at: string;
  runId: string;
  passed: boolean;
  durationMs: number;
  a11y: number;
  visualFails: number;
  perf: number | null;
}

/** Matches the "anomaly ring" format defined in P2 #20: one ring per metric,
 *  each with baseline, current, and a severity band. */
export interface AnomalyRing {
  metric: 'a11y' | 'visual' | 'perf' | 'duration' | 'flowFails';
  label: string;
  baseline: number;
  current: number;
  delta: number;
  severity: 'ok' | 'info' | 'warn' | 'fail';
}

export const history = {
  trend: (teamId: string, opts: { url?: string; days?: number } = {}) =>
    request<TrendPoint[]>(`/teams/${teamId}/history/trend`, { query: opts }),
  anomalies: (teamId: string, opts: { url?: string } = {}) =>
    request<AnomalyRing[]>(`/teams/${teamId}/history/anomalies`, { query: opts }),
};

// ─── Replays ──────────────────────────────────────────────────────────────

export interface ReplayListItem {
  id: string;
  runId: string;
  recordedAt: string;
  durationMs: number;
  url: string;
  thumbnail?: string;
  embedUrl: string;
}

export const replays = {
  list: (teamId: string, opts: { limit?: number } = {}) =>
    request<{ items: ReplayListItem[]; cursor?: string }>(`/teams/${teamId}/replays`, {
      query: { limit: opts.limit ?? 30 },
    }),
  get: (teamId: string, replayId: string) =>
    request<ReplayListItem>(`/teams/${teamId}/replays/${replayId}`),
};

// ─── Repos (P5 #48 — multi-repo aggregation) ─────────────────────────────

/**
 * Summary row returned by `GET /v1/repos`. Each entry aggregates every run
 * uploaded for a single target (`target_url`) across the workspace.
 */
export interface RepoSummary {
  /** Target URL (used as the repo identity). */
  url: string;
  /** Human-friendly hostname / slug extracted from the URL. */
  name: string;
  /** Total run count for this target. */
  totalRuns: number;
  /** Pass rate across all runs, 0..100 (integer percent). */
  passRate: number;
  /** Latest `created_at` (epoch-seconds) observed for this target. */
  lastRunAt: number | null;
  /** Rolling average composite score. May be null when no score captured. */
  avgScore: number | null;
  /** Latest run status — populated when the backend includes it. */
  lastStatus?: 'pass' | 'fail' | 'partial' | 'error';
  /** Latest coverage percent (click-coverage from explore), 0..100. */
  coverage?: number | null;
  /** Optional deploy marker (branch @ short SHA). */
  lastDeploy?: string | null;
}

export interface RepoDetailRun {
  id: string;
  status: 'pass' | 'fail' | 'partial' | 'error' | string;
  score: number | null;
  duration_ms: number;
  created_at: number;
  flow_slug?: string | null;
  viewport_w?: number | null;
  viewport_h?: number | null;
}

export interface RepoDetail {
  url: string;
  name: string;
  runs: RepoDetailRun[];
}

export const repos = {
  /** GET /v1/repos — all repos aggregated across the workspace. */
  list: () =>
    request<{ ok: true; repos: RepoSummary[] }>('/v1/repos').then((r) => r.repos),
  /** GET /v1/repos/:url — recent runs for one target URL. */
  get: (targetUrl: string) =>
    request<{ ok: true } & RepoDetail>(`/v1/repos/${encodeURIComponent(targetUrl)}`).then(
      ({ url, name, runs }) => ({ url, name, runs }),
    ),
};

// ─── Billing (Polar.sh) ───────────────────────────────────────────────────

export interface Subscription {
  id: string;
  plan: 'free' | 'pro' | 'team' | 'enterprise';
  status: 'active' | 'past_due' | 'canceled' | 'trialing';
  renewsAt?: string;
  canceledAt?: string;
  seats: number;
  seatsUsed: number;
  amountCents: number;
  currency: string;
  portalUrl?: string;
  upgradeUrl?: string;
}

export interface Invoice {
  id: string;
  number: string;
  issuedAt: string;
  paidAt?: string;
  amountCents: number;
  currency: string;
  status: 'paid' | 'open' | 'void';
  downloadUrl?: string;
}

export const billing = {
  subscription: (teamId: string) =>
    request<Subscription>(`/teams/${teamId}/billing/subscription`),
  invoices: (teamId: string) =>
    request<Invoice[]>(`/teams/${teamId}/billing/invoices`),
  checkout: (teamId: string, plan: Subscription['plan']) =>
    request<{ url: string }>(`/teams/${teamId}/billing/checkout`, {
      method: 'POST',
      body: { plan },
    }),
  portal: (teamId: string) =>
    request<{ url: string }>(`/teams/${teamId}/billing/portal`, { method: 'POST' }),
};

export { API_BASE };
