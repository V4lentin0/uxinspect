// GitHub REST calls used by the PR bot.
//
// All state-changing calls require an installation access token. The token is
// minted by:
//   1. signing a short-lived App JWT (see jwt.ts),
//   2. POST /app/installations/:installation_id/access_tokens with that JWT,
//   3. caching the returned token in KV until its `expires_at` minus 60s.
//
// We cache aggressively because every webhook delivery otherwise costs:
//   - 1 RSA sign (not free on Workers)
//   - 1 unauthenticated-ish request to GitHub
//   - 1 minted token debit against App rate limit (15k/hr total, not per-repo)

import { signGitHubAppJwt } from './jwt.js';

export interface GitHubEnv {
  TOKENS: KVNamespace;
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_API_BASE: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: number; // epoch seconds
}

// ---- Installation token flow --------------------------------------------------

export async function getInstallationToken(
  env: GitHubEnv,
  installationId: number,
): Promise<string> {
  const cacheKey = `inst:${installationId}`;
  const cached = await env.TOKENS.get(cacheKey, 'json') as InstallationToken | null;
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt - 60 > now) return cached.token;

  const jwt = await signGitHubAppJwt(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY);
  const res = await ghFetch(
    env,
    `/app/installations/${installationId}/access_tokens`,
    jwt,
    { method: 'POST' },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`installation token exchange failed: ${res.status} ${body}`);
  }
  const payload = (await res.json()) as { token: string; expires_at: string };
  const expiresAt = Math.floor(new Date(payload.expires_at).getTime() / 1000);
  const record: InstallationToken = { token: payload.token, expiresAt };
  // KV TTL can't exceed absolute expiry. Give ourselves a 60s safety margin.
  const ttl = Math.max(60, expiresAt - now - 60);
  await env.TOKENS.put(cacheKey, JSON.stringify(record), { expirationTtl: ttl });
  return payload.token;
}

// ---- Comment upsert ----------------------------------------------------------

export interface UpsertCommentArgs {
  owner: string;
  repo: string;
  issueNumber: number; // PRs share the issue-comment endpoint
  marker: string;
  body: string;
}

// Finds an existing bot comment (by marker) and edits it; otherwise creates one.
// This keeps a single comment per PR instead of spamming on every push.
export async function upsertPrComment(
  env: GitHubEnv,
  token: string,
  args: UpsertCommentArgs,
): Promise<{ id: number; action: 'created' | 'updated' }> {
  const existing = await findBotComment(env, token, args);
  if (existing) {
    const res = await ghFetch(
      env,
      `/repos/${args.owner}/${args.repo}/issues/comments/${existing.id}`,
      token,
      { method: 'PATCH', body: JSON.stringify({ body: args.body }) },
    );
    if (!res.ok) throw new Error(`PATCH comment failed: ${res.status} ${await res.text()}`);
    return { id: existing.id, action: 'updated' };
  }
  const res = await ghFetch(
    env,
    `/repos/${args.owner}/${args.repo}/issues/${args.issueNumber}/comments`,
    token,
    { method: 'POST', body: JSON.stringify({ body: args.body }) },
  );
  if (!res.ok) throw new Error(`POST comment failed: ${res.status} ${await res.text()}`);
  const payload = (await res.json()) as { id: number };
  return { id: payload.id, action: 'created' };
}

interface GhComment {
  id: number;
  body: string;
  user: { login: string; type: string } | null;
}

async function findBotComment(
  env: GitHubEnv,
  token: string,
  args: UpsertCommentArgs,
): Promise<GhComment | null> {
  // Paginate conservatively. A PR with >300 comments is an outlier; bail then.
  for (let page = 1; page <= 3; page++) {
    const res = await ghFetch(
      env,
      `/repos/${args.owner}/${args.repo}/issues/${args.issueNumber}/comments?per_page=100&page=${page}`,
      token,
    );
    if (!res.ok) throw new Error(`list comments failed: ${res.status}`);
    const comments = (await res.json()) as GhComment[];
    for (const c of comments) {
      if (c.body && c.body.includes(args.marker)) return c;
    }
    if (comments.length < 100) return null;
  }
  return null;
}

// ---- Artifact retrieval ------------------------------------------------------

export interface ArtifactRef {
  id: number;
  name: string;
  archive_download_url: string;
  expired: boolean;
}

// Lists artifacts for the head_sha's most recent workflow run and returns the
// one matching `name`. Returns null if the CI job hasn't finished yet.
export async function findArtifactForSha(
  env: GitHubEnv,
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  name: string,
): Promise<ArtifactRef | null> {
  const runsRes = await ghFetch(
    env,
    `/repos/${owner}/${repo}/actions/runs?head_sha=${headSha}&per_page=20`,
    token,
  );
  if (!runsRes.ok) return null;
  const runs = (await runsRes.json()) as {
    workflow_runs: { id: number; status: string; conclusion: string | null }[];
  };
  // Prefer completed runs; fall back to in_progress so we at least have an artifact id.
  const run =
    runs.workflow_runs.find((r) => r.status === 'completed') ?? runs.workflow_runs[0];
  if (!run) return null;
  const artRes = await ghFetch(
    env,
    `/repos/${owner}/${repo}/actions/runs/${run.id}/artifacts?per_page=100`,
    token,
  );
  if (!artRes.ok) return null;
  const arts = (await artRes.json()) as { artifacts: ArtifactRef[] };
  return arts.artifacts.find((a) => a.name === name && !a.expired) ?? null;
}

// Downloads the artifact zip, extracts a single JSON file from it, and parses.
// For production this can be swapped to stream through a Durable Object if the
// artifacts ever exceed the Worker's 100 MB memory ceiling.
export async function downloadArtifactJson(
  env: GitHubEnv,
  token: string,
  artifactId: number,
  owner: string,
  repo: string,
  fileName: string,
): Promise<unknown | null> {
  const res = await ghFetch(
    env,
    `/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`,
    token,
    { redirect: 'follow' },
  );
  if (!res.ok) return null;
  const zip = new Uint8Array(await res.arrayBuffer());
  const entry = await extractZipEntry(zip, fileName);
  if (!entry) return null;
  const text = new TextDecoder().decode(entry);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---- Low-level fetch wrapper -------------------------------------------------

export async function ghFetch(
  env: GitHubEnv,
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = `${env.GITHUB_API_BASE}${path}`;
  const headers = new Headers(init.headers as HeadersInit | undefined);
  headers.set('authorization', `Bearer ${token}`);
  headers.set('accept', 'application/vnd.github+json');
  headers.set('x-github-api-version', '2022-11-28');
  headers.set('user-agent', 'uxinspect-pr-bot');
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(url, { ...init, headers });
  // Surface rate-limit headers for observability; callers can inspect them.
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    // eslint-disable-next-line no-console
    console.warn(`github rate-limit hit: remaining=${remaining} reset=${reset}`);
  }
  return res;
}

// ---- Zip reader --------------------------------------------------------------
//
// GitHub artifact archives are zipped; entries are usually DEFLATE (method 8)
// but occasionally STORE (method 0). We locate the Local File Header for the
// wanted entry and, for DEFLATE, inflate via DecompressionStream ('deflate-raw'),
// which is supported on Workers natively — no third-party zip library.

export async function extractZipEntry(zip: Uint8Array, name: string): Promise<Uint8Array | null> {
  let i = 0;
  const wanted = new TextEncoder().encode(name);
  while (i + 30 < zip.length) {
    if (
      zip[i] === 0x50 &&
      zip[i + 1] === 0x4b &&
      zip[i + 2] === 0x03 &&
      zip[i + 3] === 0x04
    ) {
      const method = readU16(zip, i + 8);
      const compSize = readU32(zip, i + 18);
      const nameLen = readU16(zip, i + 26);
      const extraLen = readU16(zip, i + 28);
      const nameStart = i + 30;
      const dataStart = nameStart + nameLen + extraLen;
      if (
        nameLen === wanted.length &&
        bytesEqual(zip.subarray(nameStart, nameStart + nameLen), wanted)
      ) {
        const compressed = zip.subarray(dataStart, dataStart + compSize);
        if (method === 0) return compressed;
        if (method === 8) {
          const ds = new DecompressionStream('deflate-raw');
          const stream = new Response(compressed).body!.pipeThrough(ds);
          const buf = await new Response(stream).arrayBuffer();
          return new Uint8Array(buf);
        }
        return null;
      }
      i = dataStart + compSize;
      continue;
    }
    i++;
  }
  return null;
}

function readU16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function readU32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---- P6 #54 — GitHub Checks API ------------------------------------------------

export interface CheckRunOpts {
  owner: string;
  repo: string;
  headSha: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'action_required';
  name?: string;
  output?: {
    title: string;
    summary: string;
    text?: string;
    annotations?: Array<{
      path: string;
      start_line: number;
      end_line: number;
      annotation_level: 'notice' | 'warning' | 'failure';
      message: string;
      title?: string;
    }>;
  };
}

export async function createCheckRun(
  token: string,
  env: GitHubEnv,
  opts: CheckRunOpts,
): Promise<{ id: number }> {
  const base = env.GITHUB_API_BASE || 'https://api.github.com';
  const res = await fetch(`${base}/repos/${opts.owner}/${opts.repo}/check-runs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: opts.name || 'uxinspect',
      head_sha: opts.headSha,
      status: opts.status,
      conclusion: opts.conclusion,
      output: opts.output,
    }),
  });
  if (!res.ok) throw new Error(`check-run create failed: ${res.status}`);
  const data = (await res.json()) as { id: number };
  return { id: data.id };
}

export async function updateCheckRun(
  token: string,
  env: GitHubEnv,
  owner: string,
  repo: string,
  checkRunId: number,
  update: Partial<CheckRunOpts>,
): Promise<void> {
  const base = env.GITHUB_API_BASE || 'https://api.github.com';
  const res = await fetch(`${base}/repos/${owner}/${repo}/check-runs/${checkRunId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      status: update.status,
      conclusion: update.conclusion,
      output: update.output,
    }),
  });
  if (!res.ok) throw new Error(`check-run update failed: ${res.status}`);
}

// ---- P6 #55 — GitLab / Bitbucket / Azure DevOps comment posting -----------------

const BOT_MARKER = '<!-- uxinspect:bot -->';

export async function postGitLabComment(opts: {
  baseUrl: string;
  projectId: string | number;
  mrIid: string | number;
  token: string;
  body: string;
}): Promise<void> {
  const markedBody = `${BOT_MARKER}\n${opts.body}`;
  const listUrl = `${opts.baseUrl}/api/v4/projects/${opts.projectId}/merge_requests/${opts.mrIid}/notes`;
  const headers = { 'PRIVATE-TOKEN': opts.token, 'Content-Type': 'application/json' };

  // Find existing bot comment
  const res = await fetch(`${listUrl}?per_page=100`, { headers });
  if (res.ok) {
    const notes = (await res.json()) as Array<{ id: number; body: string }>;
    const existing = notes.find((n) => n.body.includes(BOT_MARKER));
    if (existing) {
      await fetch(`${listUrl}/${existing.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ body: markedBody }),
      });
      return;
    }
  }

  await fetch(listUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ body: markedBody }),
  });
}

export async function postBitbucketComment(opts: {
  workspace: string;
  repoSlug: string;
  prId: string | number;
  auth: string; // "Basic <base64>" or "Bearer <token>"
  body: string;
}): Promise<void> {
  const markedBody = `${BOT_MARKER}\n${opts.body}`;
  const base = `https://api.bitbucket.org/2.0/repositories/${opts.workspace}/${opts.repoSlug}/pullrequests/${opts.prId}/comments`;
  const headers: Record<string, string> = { Authorization: opts.auth, 'Content-Type': 'application/json' };

  const res = await fetch(`${base}?pagelen=100`, { headers });
  if (res.ok) {
    const data = (await res.json()) as { values: Array<{ id: number; content: { raw: string } }> };
    const existing = data.values?.find((c) => c.content.raw.includes(BOT_MARKER));
    if (existing) {
      await fetch(`${base}/${existing.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ content: { raw: markedBody } }),
      });
      return;
    }
  }

  await fetch(base, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content: { raw: markedBody } }),
  });
}

export async function postAzureDevOpsComment(opts: {
  orgUrl: string;
  project: string;
  repoId: string;
  prId: string | number;
  pat: string;
  body: string;
}): Promise<void> {
  const markedBody = `${BOT_MARKER}\n${opts.body}`;
  const base = `${opts.orgUrl}/${opts.project}/_apis/git/repositories/${opts.repoId}/pullRequests/${opts.prId}/threads`;
  const auth = `Basic ${btoa(`:${opts.pat}`)}`;
  const headers: Record<string, string> = { Authorization: auth, 'Content-Type': 'application/json' };

  const res = await fetch(`${base}?api-version=7.0`, { headers });
  if (res.ok) {
    const data = (await res.json()) as { value: Array<{ id: number; comments: Array<{ content: string }> }> };
    const existing = data.value?.find((t) => t.comments?.some((c) => c.content.includes(BOT_MARKER)));
    if (existing) {
      await fetch(`${base}/${existing.id}/comments/1?api-version=7.0`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ content: markedBody }),
      });
      return;
    }
  }

  await fetch(`${base}?api-version=7.0`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      comments: [{ parentCommentId: 0, content: markedBody, commentType: 1 }],
      status: 1,
    }),
  });
}
