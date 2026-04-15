import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Flow } from './types.js';

const execFileP = promisify(execFile);

export type GitRunner = (args: string[], cwd: string) => Promise<string>;

/**
 * Default git runner: shells out to the real `git` binary.
 */
export const defaultGitRunner: GitRunner = async (args, cwd) => {
  const { stdout } = await execFileP('git', args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
};

export interface GetChangedRoutesOptions {
  /** Optional injected git runner (for tests / alternate VCS wiring). */
  runGit?: GitRunner;
}

/**
 * Resolve the base ref against which we compare.
 * Precedence:
 *   1) explicit `baseRef` argument
 *   2) `GITHUB_BASE_REF` env var (GitHub Actions PR context)
 *   3) `HEAD~1` (single-commit fallback)
 */
function resolveBaseRef(baseRef?: string): string {
  if (baseRef && baseRef.length > 0) return baseRef;
  const ghBase = process.env.GITHUB_BASE_REF;
  if (ghBase && ghBase.length > 0) {
    return `origin/${ghBase}`;
  }
  return 'HEAD~1';
}

/**
 * Map a single changed file path to zero or more affected routes.
 *
 * Conventions supported:
 *  1) `app/routes/foo/page.tsx`              -> '/foo'
 *     `app/routes/foo/bar/page.tsx`          -> '/foo/bar'
 *     `app/routes/page.tsx`                  -> '/'
 *  2) `pages/foo.tsx`                        -> '/foo'
 *     `pages/foo/bar.tsx`                    -> '/foo/bar'
 *     `pages/index.tsx`                      -> '/'
 *  3) explicit `routeMap` entry              -> routes listed in the map
 */
export function fileToRoutes(
  file: string,
  routeMap?: Record<string, string[]>,
): string[] {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
  const found = new Set<string>();

  // Convention 3: explicit map overrides (additive — we still check conventions 1 & 2).
  if (routeMap && routeMap[normalized]) {
    for (const r of routeMap[normalized]) found.add(normalizeRoute(r));
  }

  // Convention 1: app/routes/<segments>/page.(tsx|ts|jsx|js)
  const appMatch = normalized.match(
    /^app\/routes\/(.*?\/)?page\.(?:tsx|ts|jsx|js)$/,
  );
  if (appMatch) {
    const segments = (appMatch[1] ?? '').replace(/\/$/, '');
    found.add(segments ? `/${segments}` : '/');
  }

  // Convention 2: pages/<segments>.(tsx|ts|jsx|js) (Next.js pages/ router).
  const pagesMatch = normalized.match(
    /^pages\/(.*?)\.(?:tsx|ts|jsx|js)$/,
  );
  if (pagesMatch) {
    let p = pagesMatch[1] ?? '';
    // pages/index -> '/', pages/foo/index -> '/foo'
    p = p.replace(/(^|\/)index$/, '');
    found.add(p ? `/${p}` : '/');
  }

  return Array.from(found);
}

function normalizeRoute(r: string): string {
  if (!r) return '/';
  if (!r.startsWith('/')) return `/${r}`;
  return r;
}

/**
 * Run `git diff --name-only <baseRef>` (relative to `repoRoot`) and return a
 * deduped list of affected routes mapped from the changed files.
 *
 * If the git invocation fails (e.g. shallow clone, detached HEAD, no history),
 * we return an empty list — callers should fall back to running all flows.
 */
export async function getChangedRoutes(
  repoRoot: string,
  baseRef?: string,
  routeMap?: Record<string, string[]>,
  opts?: GetChangedRoutesOptions,
): Promise<string[]> {
  const runner = opts?.runGit ?? defaultGitRunner;
  const ref = resolveBaseRef(baseRef);

  let rawOutput: string;
  try {
    rawOutput = await runner(['diff', '--name-only', ref], repoRoot);
  } catch {
    return [];
  }

  const files = rawOutput
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const routes = new Set<string>();
  for (const file of files) {
    for (const r of fileToRoutes(file, routeMap)) {
      routes.add(r);
    }
  }
  return Array.from(routes);
}

/**
 * Extract the pathname from any URL-ish string (absolute or path-only).
 * Returns '/' for unparseable input.
 */
function extractPath(urlish: string): string {
  if (!urlish) return '/';
  try {
    // absolute URL
    const u = new URL(urlish);
    return u.pathname || '/';
  } catch {
    // path-only (e.g. "/foo/bar?x=1")
    const q = urlish.indexOf('?');
    const h = urlish.indexOf('#');
    let end = urlish.length;
    if (q >= 0) end = Math.min(end, q);
    if (h >= 0) end = Math.min(end, h);
    const path = urlish.slice(0, end);
    return path.startsWith('/') ? path : `/${path}`;
  }
}

/**
 * True if a flow contains any `goto` step whose pathname matches (or is a
 * sub-path of) any of the changed routes.
 *
 * A changed route '/' matches every flow (root changes cascade).
 */
export function flowMatchesRoutes(flow: Flow, changedRoutes: string[]): boolean {
  if (changedRoutes.length === 0) return false;
  const normalized = changedRoutes.map(normalizeRoute);
  if (normalized.includes('/')) return true;

  for (const step of flow.steps) {
    if (typeof (step as { goto?: unknown }).goto !== 'string') continue;
    const gotoUrl = (step as { goto: string }).goto;
    const path = extractPath(gotoUrl);
    for (const r of normalized) {
      if (path === r || path.startsWith(`${r}/`)) return true;
    }
  }
  return false;
}

/**
 * Filter a list of configured flows down to only those whose goto URLs match
 * one of the changed routes.
 */
export function filterFlowsByChangedRoutes(
  flows: Flow[],
  changedRoutes: string[],
): Flow[] {
  return flows.filter((f) => flowMatchesRoutes(f, changedRoutes));
}
