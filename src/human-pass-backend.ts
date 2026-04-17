/**
 * P6 #55 — Human-pass backend gate: debugger-persona probe of every reachable
 * endpoint with payload variants, request/response dumps before + after every
 * action. Mirror of #54 FE humanPass per user instruction 2026-04-17.
 *
 * Where the FE humanPass walks the page like a real user clicking on every
 * button, hovering and typing, this BE gate acts like a real debugger
 * hammering every endpoint with variant payloads and recording the full
 * request + response round-trip — before dump (what we sent) and after dump
 * (what came back) — for every single request.
 *
 * Discovery merges:
 *   - live network trace from the supplied Playwright Page (if any),
 *   - common REST probes (/api, /api/health, /api/v1, /graphql),
 *   - sitemap.xml,
 *   - explicit endpoints from config.
 *
 * Per endpoint we exercise up to eight variants:
 *   baseline, empty-body, invalid-shape, oversize, malformed-json, unicode,
 *   auth-strip, cors-probe.
 *
 * Every request produces two dump files:
 *   NN-<method>-<path-slug>-<variant>-request.txt
 *   NN-<method>-<path-slug>-<variant>-response.txt
 *
 * NEVER throws. Individual request failures are recorded as findings with
 * kind: 'other'.
 */

import type { Page, Request as PwRequest } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

// ─── Public types ────────────────────────────────────────────────────────────

export type HumanPassBackendMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'OPTIONS';

export interface HumanPassBackendConfig {
  /** Required origin (from the inspect url). Used to resolve + scope requests. */
  baseUrl: string;
  /** Explicit endpoints. Merged with any auto-discovered ones. */
  endpoints?: Array<{
    method: HumanPassBackendMethod;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
  }>;
  /** Default true — pull endpoints from page network trace + sitemap + probes. */
  autoDiscover?: boolean;
  /** Cap. Default 40. */
  maxEndpoints?: number;
  /** Default `<outputDir>/human-pass-backend`. */
  dumpDir?: string;
  /** Per-request timeout (default 10_000). */
  timeoutMs?: number;
  /** Default true — exercise empty / valid / invalid / oversize / malformed / unicode. */
  payloadVariants?: boolean;
}

export interface HumanPassBackendFinding {
  kind:
    | 'server-error-5xx'
    | 'unexpected-2xx-on-bad-input'
    | 'slow-response'
    | 'missing-auth-enforcement'
    | 'cors-permissive'
    | 'cors-missing'
    | 'sensitive-header-leak'
    | 'idempotency-violation'
    | 'payload-echo-reflected'
    | 'other';
  /** method + path */
  endpoint: string;
  detail: string;
  /** Absolute path to raw req/resp dump. */
  dump?: string;
}

export interface HumanPassBackendResult {
  /** Ordered absolute paths of every request + response dump file. */
  dumps: string[];
  findings: HumanPassBackendFinding[];
  endpointsExercised: number;
  totalRequests: number;
  elapsedMs: number;
}

// ─── Internal shapes ─────────────────────────────────────────────────────────

type Variant =
  | 'baseline'
  | 'empty-body'
  | 'invalid-shape'
  | 'oversize'
  | 'malformed-json'
  | 'unicode'
  | 'auth-strip'
  | 'cors-probe'
  | 'baseline-retry';

interface Endpoint {
  method: HumanPassBackendMethod;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

interface RequestRecord {
  endpoint: Endpoint;
  variant: Variant;
  url: string;
  method: HumanPassBackendMethod;
  requestHeaders: Record<string, string>;
  requestBody: string | undefined;
  status: number;
  statusText: string;
  responseHeaders: Record<string, string>;
  responseBody: string;
  elapsedMs: number;
  error?: string;
  dumps: { request: string; response: string };
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_ENDPOINTS = 40;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BODY = 16 * 1024; // 16 KB
const OVERSIZE_BYTES = 1024 * 1024; // 1 MB
const SLOW_MS = 1000;
const IDEMPOTENCY_PROBE_LIMIT = 5;
const COMMON_PROBE_PATHS: ReadonlyArray<string> = [
  '/api',
  '/api/',
  '/api/health',
  '/api/v1',
  '/api/v1/',
  '/graphql',
];

const VENDOR_LEAK_HEADERS: ReadonlyArray<string> = [
  'x-powered-by',
  'x-aspnet-version',
  'x-aspnetmvc-version',
];

const MUTATING_METHODS: ReadonlyArray<HumanPassBackendMethod> = [
  'POST',
  'PUT',
  'PATCH',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nowMs(): number {
  return Date.now();
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function normaliseBaseUrl(input: string): string {
  return input.replace(/\/+$/, '');
}

/** Stable kebab-case slug for a path, capped at 48 chars. */
function slugPath(path: string): string {
  const cleaned = path
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/\?.*$/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  const base = cleaned.length === 0 ? 'root' : cleaned;
  return base.length <= 48 ? base : base.slice(0, 48);
}

function sameOrigin(url: string, base: string): boolean {
  try {
    const u = new URL(url);
    const b = new URL(base);
    return u.origin === b.origin;
  } catch {
    return false;
  }
}

function toAbsolute(url: string, base: string): string | null {
  try {
    return new URL(url, base).toString();
  } catch {
    return null;
  }
}

function serialiseHeaders(h: Record<string, string> | Headers): Record<string, string> {
  const out: Record<string, string> = {};
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

function stringifyBody(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n[…truncated ${text.length - cap} chars]`;
}

function methodAllowsBody(method: HumanPassBackendMethod): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH';
}

function looksAuthed(headers: Record<string, string>): boolean {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return Boolean(lower['authorization'] || lower['cookie']);
}

function stripAuth(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'authorization' || lk === 'cookie') continue;
    out[k] = v;
  }
  return out;
}

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * Attach a response listener and return a function that disconnects it and
 * yields the captured same-origin XHR/fetch endpoint list.
 */
function observePageNetwork(
  page: Page,
  base: string,
): () => Array<{ method: HumanPassBackendMethod; path: string }> {
  const seen = new Map<string, { method: HumanPassBackendMethod; path: string }>();
  const listener = (req: PwRequest): void => {
    try {
      const type = req.resourceType();
      if (type !== 'xhr' && type !== 'fetch') return;
      const url = req.url();
      if (!sameOrigin(url, base)) return;
      const method = req.method().toUpperCase() as HumanPassBackendMethod;
      if (
        method !== 'GET' &&
        method !== 'POST' &&
        method !== 'PUT' &&
        method !== 'PATCH' &&
        method !== 'DELETE' &&
        method !== 'OPTIONS'
      )
        return;
      const parsed = new URL(url);
      const path = parsed.pathname + (parsed.search || '');
      const key = `${method} ${path}`;
      if (!seen.has(key)) seen.set(key, { method, path });
    } catch {
      /* swallow */
    }
  };
  page.on('request', listener);
  return () => {
    try {
      page.off('request', listener);
    } catch {
      /* swallow */
    }
    return Array.from(seen.values());
  };
}

/** Best-effort sitemap.xml parse. Returns same-origin paths only. */
async function discoverFromSitemap(
  base: string,
  timeoutMs: number,
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/sitemap.xml`, {
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) return [];
    const text = await res.text();
    const paths: string[] = [];
    const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = m[1];
      if (!raw) continue;
      if (!sameOrigin(raw, base)) continue;
      try {
        const p = new URL(raw).pathname;
        if (p && p !== '/') paths.push(p);
      } catch {
        /* skip malformed */
      }
    }
    return paths;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Ping each common REST probe. Any that responds with non-404 is worth keeping. */
async function discoverFromProbes(
  base: string,
  timeoutMs: number,
): Promise<string[]> {
  const hits: string[] = [];
  await Promise.all(
    COMMON_PROBE_PATHS.map(async (p) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(base + p, {
          method: 'GET',
          signal: controller.signal,
          redirect: 'manual',
        });
        if (res.status !== 404 && res.status !== 0) hits.push(p);
      } catch {
        /* skip */
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return hits;
}

// ─── Variant builders ────────────────────────────────────────────────────────

interface PreparedVariant {
  method: HumanPassBackendMethod;
  headers: Record<string, string>;
  body: string | undefined;
  /** Unique token we can later grep for in responses to detect echo. */
  echoToken?: string;
}

function emojiUnicodeBody(): string {
  // Emoji + RTL (U+202E) + zero-width joiner + zero-width space.
  return JSON.stringify({
    emoji: '\uD83D\uDE80\uD83D\uDD25',
    rtl: '\u202Eevil\u202C',
    zwj: 'a\u200Db',
    zws: 'a\u200Bb',
  });
}

function oversizeBody(token: string): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const out: string[] = [];
  // Prefix with the echo token so even partially-reflected responses light up.
  out.push(token);
  let size = token.length;
  while (size < OVERSIZE_BYTES) {
    out.push(chars);
    size += chars.length;
  }
  return out.join('');
}

function prepareVariant(
  endpoint: Endpoint,
  variant: Variant,
): PreparedVariant | null {
  const baseHeaders: Record<string, string> = {
    accept: 'application/json, text/*;q=0.8, */*;q=0.5',
    'user-agent': 'uxinspect-human-pass-backend/1.0',
    ...(endpoint.headers ?? {}),
  };
  const baseBody = stringifyBody(endpoint.body);

  switch (variant) {
    case 'baseline':
    case 'baseline-retry': {
      const headers = { ...baseHeaders };
      if (baseBody !== undefined && methodAllowsBody(endpoint.method)) {
        headers['content-type'] = headers['content-type'] ?? 'application/json';
        return { method: endpoint.method, headers, body: baseBody };
      }
      return { method: endpoint.method, headers, body: undefined };
    }
    case 'empty-body': {
      if (!methodAllowsBody(endpoint.method)) return null;
      return {
        method: endpoint.method,
        headers: { ...baseHeaders, 'content-type': 'application/json' },
        body: '{}',
      };
    }
    case 'invalid-shape': {
      if (!methodAllowsBody(endpoint.method)) return null;
      return {
        method: endpoint.method,
        headers: { ...baseHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ this: 'is not what you want' }),
      };
    }
    case 'oversize': {
      const token = `uxi-echo-${randomBytes(8).toString('hex')}`;
      const body = oversizeBody(token);
      if (!methodAllowsBody(endpoint.method)) {
        // For non-mutating methods, smuggle the payload into a header instead.
        return {
          method: endpoint.method,
          headers: { ...baseHeaders, 'x-uxi-oversize': token },
          body: undefined,
          echoToken: token,
        };
      }
      return {
        method: endpoint.method,
        headers: { ...baseHeaders, 'content-type': 'text/plain' },
        body,
        echoToken: token,
      };
    }
    case 'malformed-json': {
      if (!methodAllowsBody(endpoint.method)) return null;
      return {
        method: endpoint.method,
        headers: { ...baseHeaders, 'content-type': 'application/json' },
        body: '{ "broken" : ',
      };
    }
    case 'unicode': {
      if (!methodAllowsBody(endpoint.method)) return null;
      return {
        method: endpoint.method,
        headers: { ...baseHeaders, 'content-type': 'application/json' },
        body: emojiUnicodeBody(),
      };
    }
    case 'auth-strip': {
      const stripped = stripAuth(baseHeaders);
      if (methodAllowsBody(endpoint.method) && baseBody !== undefined) {
        stripped['content-type'] = stripped['content-type'] ?? 'application/json';
        return { method: endpoint.method, headers: stripped, body: baseBody };
      }
      return { method: endpoint.method, headers: stripped, body: undefined };
    }
    case 'cors-probe': {
      return {
        method: 'OPTIONS',
        headers: {
          ...baseHeaders,
          origin: 'https://evil.example',
          'access-control-request-method': endpoint.method,
          'access-control-request-headers': 'authorization,content-type',
        },
        body: undefined,
      };
    }
    default:
      return null;
  }
}

// ─── Dump writer ─────────────────────────────────────────────────────────────

interface DumpPaths {
  request: string;
  response: string;
}

async function writeDumpPair(
  dir: string,
  counter: number,
  rec: Omit<RequestRecord, 'dumps'>,
): Promise<DumpPaths> {
  const slug = slugPath(rec.endpoint.path);
  const tag = `${pad2(counter)}-${rec.method.toLowerCase()}-${slug}-${rec.variant}`;
  const reqPath = resolve(join(dir, `${tag}-request.txt`));
  const resPath = resolve(join(dir, `${tag}-response.txt`));

  const reqText = [
    `# ${rec.method} ${rec.url}`,
    `# variant: ${rec.variant}`,
    `# endpoint: ${rec.endpoint.method} ${rec.endpoint.path}`,
    '',
    '## Request headers',
    ...Object.entries(rec.requestHeaders).map(([k, v]) => `${k}: ${v}`),
    '',
    '## Request body',
    rec.requestBody === undefined ? '<none>' : truncate(rec.requestBody, MAX_RESPONSE_BODY),
  ].join('\n');

  const resText = [
    `# ${rec.method} ${rec.url}`,
    `# variant: ${rec.variant}`,
    `# elapsedMs: ${rec.elapsedMs}`,
    `# status: ${rec.status} ${rec.statusText}`,
    ...(rec.error ? [`# error: ${rec.error}`] : []),
    '',
    '## Response headers',
    ...Object.entries(rec.responseHeaders).map(([k, v]) => `${k}: ${v}`),
    '',
    '## Response body',
    truncate(rec.responseBody, MAX_RESPONSE_BODY),
  ].join('\n');

  try {
    await writeFile(reqPath, reqText, 'utf8');
    await writeFile(resPath, resText, 'utf8');
  } catch {
    /* swallow — dump failure must not abort the run */
  }
  return { request: reqPath, response: resPath };
}

// ─── Executor ────────────────────────────────────────────────────────────────

async function executeRequest(
  endpoint: Endpoint,
  variant: Variant,
  base: string,
  timeoutMs: number,
): Promise<Omit<RequestRecord, 'dumps'> | null> {
  const prepared = prepareVariant(endpoint, variant);
  if (!prepared) return null;

  const absUrl = toAbsolute(endpoint.path, base) ?? `${base}${endpoint.path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = nowMs();

  const init: RequestInit = {
    method: prepared.method,
    headers: prepared.headers,
    redirect: 'manual',
    signal: controller.signal,
  };
  if (prepared.body !== undefined) init.body = prepared.body;

  let status = 0;
  let statusText = '';
  let resHeaders: Record<string, string> = {};
  let resBody = '';
  let err: string | undefined;

  try {
    const res = await fetch(absUrl, init);
    status = res.status;
    statusText = res.statusText;
    resHeaders = serialiseHeaders(res.headers);
    try {
      resBody = await res.text();
    } catch (bodyErr) {
      resBody = '';
      err = `body read failed: ${bodyErr instanceof Error ? bodyErr.message : String(bodyErr)}`;
    }
  } catch (fetchErr) {
    err = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
  } finally {
    clearTimeout(timer);
  }

  const elapsedMs = nowMs() - startedAt;

  const record: Omit<RequestRecord, 'dumps'> = {
    endpoint,
    variant,
    url: absUrl,
    method: prepared.method,
    requestHeaders: prepared.headers,
    requestBody: prepared.body,
    status,
    statusText,
    responseHeaders: resHeaders,
    responseBody: resBody,
    elapsedMs,
  };
  if (err) record.error = err;
  return record;
}

// ─── Findings ────────────────────────────────────────────────────────────────

function findingsForRecord(
  rec: RequestRecord,
  baselineStatus: number | undefined,
  echoToken: string | undefined,
): HumanPassBackendFinding[] {
  const endpointId = `${rec.endpoint.method} ${rec.endpoint.path}`;
  const out: HumanPassBackendFinding[] = [];
  const dump = rec.dumps.response;

  // Transport-level failure surfaces as 'other' only — the caller already
  // sees every dump. We still record it so the report shows the variant.
  if (rec.error) {
    out.push({
      kind: 'other',
      endpoint: endpointId,
      detail: `fetch failed: ${rec.error} (variant ${rec.variant})`,
      dump,
    });
    return out;
  }

  // 5xx — only on a real response, not a 0 we generated on fetch failure.
  if (rec.status >= 500 && rec.status < 600) {
    out.push({
      kind: 'server-error-5xx',
      endpoint: endpointId,
      detail: `${rec.method} ${rec.url} → ${rec.status} ${rec.statusText} (variant ${rec.variant})`,
      dump,
    });
  }

  // Slow response.
  if (rec.elapsedMs > SLOW_MS && rec.status > 0) {
    out.push({
      kind: 'slow-response',
      endpoint: endpointId,
      detail: `${rec.variant} took ${rec.elapsedMs}ms (> ${SLOW_MS}ms)`,
      dump,
    });
  }

  // Sensitive vendor headers.
  for (const h of VENDOR_LEAK_HEADERS) {
    const val = rec.responseHeaders[h];
    if (val) {
      out.push({
        kind: 'sensitive-header-leak',
        endpoint: endpointId,
        detail: `${h}: ${val}`,
        dump,
      });
    }
  }
  const server = rec.responseHeaders['server'];
  if (server && /\/\d/.test(server)) {
    out.push({
      kind: 'sensitive-header-leak',
      endpoint: endpointId,
      detail: `server: ${server}`,
      dump,
    });
  }

  // invalid-shape accepted.
  if (rec.variant === 'invalid-shape' && rec.status >= 200 && rec.status < 300) {
    out.push({
      kind: 'unexpected-2xx-on-bad-input',
      endpoint: endpointId,
      detail: `invalid-shape body accepted with ${rec.status}`,
      dump,
    });
  }

  // malformed-json accepted.
  if (rec.variant === 'malformed-json' && rec.status >= 200 && rec.status < 300) {
    out.push({
      kind: 'unexpected-2xx-on-bad-input',
      endpoint: endpointId,
      detail: `malformed JSON body accepted with ${rec.status}`,
      dump,
    });
  }

  // auth-strip enforcement.
  if (
    rec.variant === 'auth-strip' &&
    baselineStatus !== undefined &&
    baselineStatus >= 200 &&
    baselineStatus < 300 &&
    looksAuthed(rec.endpoint.headers ?? {}) &&
    rec.status >= 200 &&
    rec.status < 300
  ) {
    out.push({
      kind: 'missing-auth-enforcement',
      endpoint: endpointId,
      detail: `baseline required auth (headers present) but auth-strip still returned ${rec.status}`,
      dump,
    });
  }

  // CORS analysis.
  const acao = rec.responseHeaders['access-control-allow-origin'];
  const acac = rec.responseHeaders['access-control-allow-credentials'];
  if (rec.variant === 'cors-probe' && rec.status > 0) {
    if (acao === '*' && acac === 'true') {
      out.push({
        kind: 'cors-permissive',
        endpoint: endpointId,
        detail: 'preflight allows "*" with credentials — permissive CORS',
        dump,
      });
    } else if (acao === 'https://evil.example') {
      out.push({
        kind: 'cors-permissive',
        endpoint: endpointId,
        detail: 'preflight reflected evil Origin unsanitised',
        dump,
      });
    }
  } else if (rec.variant !== 'cors-probe' && rec.status > 0) {
    // Non-preflight: if an explicit mismatched Origin header was sent but the
    // server returned no Access-Control-Allow-Origin, flag it.
    const origin = rec.requestHeaders['origin'];
    if (origin && !sameOrigin(origin, rec.url) && !acao) {
      out.push({
        kind: 'cors-missing',
        endpoint: endpointId,
        detail: `XHR Origin ${origin} did not match response and no Access-Control-Allow-Origin header returned`,
        dump,
      });
    }
  }

  // Payload echo.
  if (echoToken && rec.responseBody.includes(echoToken)) {
    out.push({
      kind: 'payload-echo-reflected',
      endpoint: endpointId,
      detail: `oversize payload token echoed back verbatim (variant ${rec.variant})`,
      dump,
    });
  }

  return out;
}

// ─── Orchestration ──────────────────────────────────────────────────────────

/** Deduplicate and cap endpoints while preserving insertion order. */
function dedupeEndpoints(list: Endpoint[], cap: number): Endpoint[] {
  const seen = new Set<string>();
  const out: Endpoint[] = [];
  for (const ep of list) {
    const key = `${ep.method} ${ep.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ep);
    if (out.length >= cap) break;
  }
  return out;
}

function variantListFor(
  method: HumanPassBackendMethod,
  enabled: boolean,
): Variant[] {
  const base: Variant[] = ['baseline'];
  if (!enabled) {
    base.push('auth-strip', 'cors-probe');
    return base;
  }
  if (methodAllowsBody(method)) {
    base.push('empty-body', 'invalid-shape', 'malformed-json', 'unicode');
  }
  base.push('oversize', 'auth-strip', 'cors-probe');
  return base;
}

// ─── Main entry ──────────────────────────────────────────────────────────────

export async function runHumanPassBackend(
  page: Page | undefined,
  config: HumanPassBackendConfig,
): Promise<HumanPassBackendResult> {
  const startedAt = nowMs();
  const dumps: string[] = [];
  const findings: HumanPassBackendFinding[] = [];

  // ── Config normalisation ───────────────────────────────────────────────
  if (!config.baseUrl) {
    return {
      dumps,
      findings: [
        {
          kind: 'other',
          endpoint: 'n/a',
          detail: 'runHumanPassBackend: baseUrl is required',
        },
      ],
      endpointsExercised: 0,
      totalRequests: 0,
      elapsedMs: nowMs() - startedAt,
    };
  }
  const base = normaliseBaseUrl(config.baseUrl);
  const autoDiscover = config.autoDiscover !== false;
  const maxEndpoints = Math.max(1, config.maxEndpoints ?? DEFAULT_MAX_ENDPOINTS);
  const timeoutMs = Math.max(500, config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const payloadVariants = config.payloadVariants !== false;
  const dumpDir = resolve(config.dumpDir ?? join(process.cwd(), 'human-pass-backend'));

  try {
    await mkdir(dumpDir, { recursive: true });
  } catch {
    /* directory may already exist; writes below will error softly if not */
  }

  // ── Attach live network listener early so it captures traffic during
  //    discovery + subsequent page activity the caller drove beforehand.
  const harvest = page ? observePageNetwork(page, base) : () => [];

  // ── Discovery ──────────────────────────────────────────────────────────
  const discovered: Endpoint[] = [];

  if (autoDiscover) {
    const networkHits = harvest();
    for (const h of networkHits) {
      discovered.push({ method: h.method, path: h.path });
    }

    const [sitemap, probes] = await Promise.all([
      discoverFromSitemap(base, timeoutMs),
      discoverFromProbes(base, timeoutMs),
    ]);
    for (const p of sitemap) discovered.push({ method: 'GET', path: p });
    for (const p of probes) discovered.push({ method: 'GET', path: p });
  } else {
    // We still want to disconnect the listener cleanly.
    harvest();
  }

  const explicit: Endpoint[] = (config.endpoints ?? []).map((e) => {
    const ep: Endpoint = { method: e.method, path: e.path };
    if (e.headers) ep.headers = e.headers;
    if (e.body !== undefined) ep.body = e.body;
    return ep;
  });

  const endpoints = dedupeEndpoints([...explicit, ...discovered], maxEndpoints);

  if (endpoints.length === 0) {
    return {
      dumps,
      findings,
      endpointsExercised: 0,
      totalRequests: 0,
      elapsedMs: nowMs() - startedAt,
    };
  }

  // ── Execution ──────────────────────────────────────────────────────────
  let counter = 1;
  let totalRequests = 0;
  let mutatingProbed = 0;

  for (const endpoint of endpoints) {
    const variants = variantListFor(endpoint.method, payloadVariants);
    let baselineStatus: number | undefined;

    // Idempotency probe runs as a second baseline on the first
    // IDEMPOTENCY_PROBE_LIMIT mutating endpoints only.
    const wantsIdempotency =
      MUTATING_METHODS.includes(endpoint.method) &&
      mutatingProbed < IDEMPOTENCY_PROBE_LIMIT;
    if (wantsIdempotency) {
      mutatingProbed += 1;
      variants.push('baseline-retry');
    }

    let firstBaseline: RequestRecord | null = null;

    for (const variant of variants) {
      const prepared = prepareVariant(endpoint, variant);
      const tokenForRecord =
        prepared && prepared.echoToken ? prepared.echoToken : undefined;

      let record: Omit<RequestRecord, 'dumps'> | null = null;
      try {
        record = await executeRequest(endpoint, variant, base, timeoutMs);
      } catch (execErr) {
        record = {
          endpoint,
          variant,
          url: toAbsolute(endpoint.path, base) ?? `${base}${endpoint.path}`,
          method: prepared?.method ?? endpoint.method,
          requestHeaders: prepared?.headers ?? {},
          requestBody: prepared?.body,
          status: 0,
          statusText: '',
          responseHeaders: {},
          responseBody: '',
          elapsedMs: 0,
          error:
            execErr instanceof Error ? execErr.message : String(execErr),
        };
      }

      if (!record) continue;
      totalRequests += 1;

      const dumpPaths = await writeDumpPair(dumpDir, counter, record);
      counter += 1;
      dumps.push(dumpPaths.request, dumpPaths.response);

      const full: RequestRecord = { ...record, dumps: dumpPaths };

      if (variant === 'baseline') {
        baselineStatus = record.status;
        firstBaseline = full;
      }

      for (const f of findingsForRecord(full, baselineStatus, tokenForRecord)) {
        findings.push(f);
      }

      // Idempotency check — two successful baseline creates with different IDs.
      if (variant === 'baseline-retry' && firstBaseline) {
        const a = firstBaseline;
        const b = full;
        const aOk = a.status >= 200 && a.status < 300;
        const bOk = b.status >= 200 && b.status < 300;
        if (aOk && bOk) {
          const aId = extractId(a.responseBody, a.responseHeaders);
          const bId = extractId(b.responseBody, b.responseHeaders);
          if (aId && bId && aId !== bId) {
            findings.push({
              kind: 'idempotency-violation',
              endpoint: `${endpoint.method} ${endpoint.path}`,
              detail: `two identical ${endpoint.method} requests each produced a distinct id (${aId} vs ${bId}) — no idempotency key enforcement`,
              dump: b.dumps.response,
            });
          }
        }
      }
    }
  }

  return {
    dumps,
    findings,
    endpointsExercised: endpoints.length,
    totalRequests,
    elapsedMs: nowMs() - startedAt,
  };
}

// ─── Response ID extraction for idempotency check ───────────────────────────

const LOCATION_ID_RE = /\/([A-Za-z0-9_-]{4,})\/?$/;

/**
 * Best-effort extract of a resource id from a creation response. Looks at
 * Location header first (REST idiom), then common JSON id fields in the body.
 */
function extractId(
  body: string,
  headers: Record<string, string>,
): string | null {
  const loc = headers['location'];
  if (loc) {
    const m = LOCATION_ID_RE.exec(loc);
    if (m && m[1]) return m[1];
  }
  const trimmed = body.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return pluckIdField(parsed);
  } catch {
    return null;
  }
}

function pluckIdField(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const r = pluckIdField(item);
      if (r) return r;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const keys = ['id', 'ID', '_id', 'uuid', 'uid', 'resource_id', 'resourceId'];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  // Check nested data/result envelopes.
  for (const envelope of ['data', 'result', 'item', 'resource']) {
    if (envelope in obj) {
      const r = pluckIdField(obj[envelope]);
      if (r) return r;
    }
  }
  return null;
}
