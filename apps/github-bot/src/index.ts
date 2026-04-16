// uxinspect GitHub App — Cloudflare Worker entry point.
//
// Route (set in wrangler.toml):
//   POST https://pr.uxinspect.com/webhooks/github
//
// Flow:
//   1. Validate `x-hub-signature-256` HMAC-SHA256 against GITHUB_WEBHOOK_SECRET.
//      Constant-time compare. Missing header or bad signature -> 401.
//   2. Inspect `x-github-event`. Only `pull_request` with action in
//      {opened, reopened, synchronize, edited} triggers work; everything else
//      returns 204.
//   3. Mint (or reuse cached) installation access token for the repo.
//   4. Find the latest workflow run on the head_sha, grab the
//      `uxinspect-result` artifact, read `result.json` from its zip.
//   5. Ask api.uxinspect.com for the diff vs main baseline. If the API is
//      unreachable, fall back to a naive flow-list diff (no baseline = no diff).
//   6. Render markdown via comment-renderer and upsert it on the PR. The
//      marker `<!-- uxinspect:pr-bot -->` makes the comment editable on every
//      subsequent push instead of posting duplicates.
//
// Everything heavy runs inside ctx.waitUntil so webhook deliveries ack fast
// (GitHub times out at 10s and disables the App after repeated failures).

import {
  extractZipEntry,
  findArtifactForSha,
  getInstallationToken,
  type GitHubEnv,
  upsertPrComment,
  ghFetch,
} from './github-api.js';
import { diffSnapshots, renderComment, type ResultSnapshot, type DiffOutcome } from './comment-renderer.js';

export interface Env extends GitHubEnv {
  TOKENS: KVNamespace;
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  API_INTERNAL_TOKEN: string;
  COMMENT_MARKER: string;
  UXINSPECT_API_BASE: string;
  GITHUB_API_BASE: string;
  ARTIFACT_NAME: string;
  ARTIFACT_FILE: string;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && path === '/') return text('uxinspect github-bot ok', 200);
    if (req.method === 'POST' && path === '/webhooks/github') return webhook(req, env, ctx);
    return text('not found', 404);
  },
};

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

// ---- Webhook entry ----------------------------------------------------------

async function webhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.GITHUB_WEBHOOK_SECRET) return text('webhook secret not configured', 500);

  const raw = await req.text();
  const sig = req.headers.get('x-hub-signature-256') ?? '';
  const ok = await verifyGitHubSignature(raw, sig, env.GITHUB_WEBHOOK_SECRET);
  if (!ok) return text('invalid signature', 401);

  const event = req.headers.get('x-github-event') ?? '';
  const deliveryId = req.headers.get('x-github-delivery') ?? '';
  if (event === 'ping') return text('pong', 200);
  if (event !== 'pull_request') return text('ignored', 204);

  let payload: PullRequestEvent;
  try {
    payload = JSON.parse(raw) as PullRequestEvent;
  } catch {
    return text('invalid json', 400);
  }

  const action = payload.action;
  if (!['opened', 'reopened', 'synchronize', 'edited'].includes(action)) {
    return text('ignored action', 204);
  }

  // Fire-and-forget: return 200 immediately, do the real work in background.
  ctx.waitUntil(processPr(env, payload, deliveryId).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('pr processing failed', deliveryId, err);
  }));
  return text('accepted', 202);
}

// ---- HMAC signature check ---------------------------------------------------

// GitHub sends `x-hub-signature-256: sha256=<hex>` where the HMAC covers the
// raw request body. Constant-time compare to avoid timing oracles.
export async function verifyGitHubSignature(
  body: string,
  header: string,
  secret: string,
): Promise<boolean> {
  if (!header.startsWith('sha256=')) return false;
  const provided = header.slice('sha256='.length).trim();
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const expected = bufToHex(new Uint8Array(sigBuf));
  return timingSafeEqual(provided, expected);
}

function bufToHex(buf: Uint8Array): string {
  let s = '';
  for (let i = 0; i < buf.length; i++) s += buf[i].toString(16).padStart(2, '0');
  return s;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---- PR processing pipeline -------------------------------------------------

interface PullRequestEvent {
  action: string;
  installation?: { id: number };
  repository: { full_name: string; name: string; owner: { login: string } };
  pull_request: {
    number: number;
    head: { sha: string; ref: string };
    base: { sha: string; ref: string };
    html_url: string;
  };
}

async function processPr(env: Env, payload: PullRequestEvent, deliveryId: string): Promise<void> {
  if (!payload.installation?.id) {
    console.warn('no installation id on payload', deliveryId);
    return;
  }
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const prNumber = payload.pull_request.number;
  const headSha = payload.pull_request.head.sha;
  const baseSha = payload.pull_request.base.sha;
  const installationId = payload.installation.id;

  const token = await getInstallationToken(env, installationId);

  const prSnapshot = await loadArtifactSnapshot(env, token, owner, repo, headSha);
  if (!prSnapshot) {
    // CI hasn't uploaded yet. Leave a pending marker so the comment isn't empty
    // when check runs eventually finish. Subsequent synchronize events will
    // reprocess the same PR and overwrite this.
    await upsertPrComment(env, token, {
      owner,
      repo,
      issueNumber: prNumber,
      marker: env.COMMENT_MARKER,
      body: renderPending(env.COMMENT_MARKER, headSha),
    });
    return;
  }

  const diff = await fetchBaselineDiff(env, owner, repo, baseSha, prSnapshot).catch(() => null);
  const resolvedDiff: DiffOutcome = diff ?? diffSnapshots(null, prSnapshot);

  const body = renderComment({
    marker: env.COMMENT_MARKER,
    prSha: headSha,
    baselineSha: baseSha,
    diff: resolvedDiff,
    prResult: prSnapshot,
    generatedAt: new Date().toISOString(),
  });

  await upsertPrComment(env, token, {
    owner,
    repo,
    issueNumber: prNumber,
    marker: env.COMMENT_MARKER,
    body,
  });
}

function renderPending(marker: string, headSha: string): string {
  const shortSha = headSha.slice(0, 7);
  return [
    marker,
    '### uxinspect — PR verification',
    '',
    '**Status:** waiting for CI — no `uxinspect-result` artifact has been uploaded yet.',
    '',
    `Once the CI workflow finishes publishing its \`result.json\` artifact for \`${shortSha}\`, this comment will update automatically with the diff against main.`,
  ].join('\n');
}

// ---- Artifact + API helpers -------------------------------------------------

async function loadArtifactSnapshot(
  env: Env,
  token: string,
  owner: string,
  repo: string,
  headSha: string,
): Promise<ResultSnapshot | null> {
  const art = await findArtifactForSha(env, token, owner, repo, headSha, env.ARTIFACT_NAME);
  if (!art) return null;
  // downloadArtifactJson redirects through GitHub's temporary URL; we inline
  // the fetch + zip extraction here so we can also surface the artifact's raw
  // ResultSnapshot without re-JSON.parse-ing.
  const res = await ghFetch(
    env,
    `/repos/${owner}/${repo}/actions/artifacts/${art.id}/zip`,
    token,
    { redirect: 'follow' },
  );
  if (!res.ok) return null;
  const zip = new Uint8Array(await res.arrayBuffer());
  const entry = await extractZipEntry(zip, env.ARTIFACT_FILE);
  if (!entry) return null;
  try {
    return JSON.parse(new TextDecoder().decode(entry)) as ResultSnapshot;
  } catch {
    return null;
  }
}

// Calls api.uxinspect.com/internal/diff with the PR snapshot. The API is the
// source of truth for baseline results; it stores the last green `main` run in
// its own D1 / KV store and returns a fully-resolved DiffOutcome. If the API
// is down or returns 5xx, caller falls back to client-side diff.
async function fetchBaselineDiff(
  env: Env,
  owner: string,
  repo: string,
  baseSha: string,
  pr: ResultSnapshot,
): Promise<DiffOutcome | null> {
  if (!env.API_INTERNAL_TOKEN) return null;
  const res = await fetch(`${env.UXINSPECT_API_BASE}/internal/diff`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.API_INTERNAL_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ owner, repo, baseSha, prResult: pr }),
  });
  if (!res.ok) return null;
  return (await res.json()) as DiffOutcome;
}
