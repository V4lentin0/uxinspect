import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Flow, Step } from './types.js';

const execFileP = promisify(execFile);

/**
 * Route map config shape (P3 #30 — Git-diff mode).
 *
 * Keys are glob patterns matched against changed file paths; values are the
 * list of route URL patterns those files affect. Route patterns are matched
 * against `goto` URLs inside each flow, either as substrings of the path or
 * as explicit globs ending in `**`.
 *
 * @example
 *   {
 *     "src/pages/checkout/**": ["/checkout", "/checkout/confirm"],
 *     "app/admin/**": ["/admin/**"],
 *   }
 */
export type RouteMap = Record<string, string[]>;

/**
 * Sentinel returned from {@link matchFilesToRoutes} when a changed file does
 * not match any configured or default file→route mapping. Downstream callers
 * must treat this as "affects all flows" so the safe default is to run
 * everything when we cannot prove a narrower scope.
 */
export const ALL_ROUTES = '*';

/**
 * Built-in file→route heuristics that kick in when the user does not supply a
 * `routeMap` in their config. Patterns follow common framework route
 * conventions (no brand names referenced on purpose — see user docs).
 *
 * Each entry maps a changed file glob to a transform that derives the URL
 * path from the changed file. Heuristics are tried in order; the first match
 * wins.
 */
const DEFAULT_HEURISTICS: Array<{
  match: RegExp;
  /** Extract route pattern(s) from the captured file path. */
  derive: (captured: string) => string[];
}> = [
  // App-router style: app/**/page.{tsx,ts,jsx,js} -> directory path
  {
    match: /^app\/(.+)\/page\.(tsx|ts|jsx|js)$/,
    derive: (dir) => [toRoute(dir)],
  },
  // App-router style: app/**/route.{ts,js} (API routes also map to URL path)
  {
    match: /^app\/(.+)\/route\.(ts|js)$/,
    derive: (dir) => [toRoute(dir)],
  },
  // Pages-router style: pages/**/*.{tsx,ts,jsx,js}
  {
    match: /^pages\/(.+)\.(tsx|ts|jsx|js)$/,
    derive: (file) => [toRoute(stripIndex(file))],
  },
  // src/pages/**/*.{tsx,ts,jsx,js}
  {
    match: /^src\/pages\/(.+)\.(tsx|ts|jsx|js)$/,
    derive: (file) => [toRoute(stripIndex(file))],
  },
  // File-router style: src/routes/**/*.(svelte|tsx|ts|jsx|js|vue)
  {
    match: /^src\/routes\/(.+)\.(svelte|tsx|ts|jsx|js|vue)$/,
    derive: (file) => [toRoute(stripIndex(file))],
  },
  // routes/**/*.(svelte|tsx|ts|jsx|js|vue)
  {
    match: /^routes\/(.+)\.(svelte|tsx|ts|jsx|js|vue)$/,
    derive: (file) => [toRoute(stripIndex(file))],
  },
];

function stripIndex(p: string): string {
  return p.replace(/\/index$/, '').replace(/^index$/, '');
}

function toRoute(p: string): string {
  // Strip route-group parentheses like (marketing)/ used by framework
  // conventions; these don't affect the URL path.
  const cleaned = p
    .split('/')
    .filter((seg) => !/^\(.*\)$/.test(seg))
    .join('/');
  if (!cleaned || cleaned === '') return '/';
  return '/' + cleaned;
}

/**
 * Spawn `git diff --name-only <ref>` and return the changed files. Defaults
 * to `HEAD~1` so the common "what changed in the last commit" case works out
 * of the box.
 */
export async function getChangedFiles(ref: string = 'HEAD~1', cwd?: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP('git', ['diff', '--name-only', ref], {
      cwd: cwd ?? process.cwd(),
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    throw new Error(`git diff failed for ref "${ref}": ${msg}`);
  }
}

/**
 * Convert a glob pattern into an anchored regular expression. Supports `*`
 * (any char except `/`), `**` (any characters including `/`) and literal
 * path separators. Used both for matching changed files against `routeMap`
 * keys and for matching `goto` URLs against route patterns.
 */
export function globToRegex(glob: string): RegExp {
  // Escape regex metachars except `*`, which we rewrite below.
  let src = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        src += '.*';
        i += 2;
        // Eat a trailing `/` so that `foo/**/bar` also matches `foo/bar`.
        if (glob[i] === '/') i += 1;
      } else {
        src += '[^/]*';
        i += 1;
      }
    } else if ('.+?^${}()|[]\\'.includes(ch)) {
      src += '\\' + ch;
      i += 1;
    } else {
      src += ch;
      i += 1;
    }
  }
  return new RegExp('^' + src + '$');
}

/**
 * Map a list of changed file paths to the route patterns they affect.
 *
 * When `routeMap` is provided, its keys are treated as globs and each
 * matching file contributes the mapped route patterns.
 *
 * When `routeMap` is empty/omitted, default framework-route-convention
 * heuristics are applied (see {@link DEFAULT_HEURISTICS}).
 *
 * Any changed file that does not match any rule triggers a wildcard
 * ({@link ALL_ROUTES}) entry, which instructs {@link filterFlowsByRoutes}
 * to fall back to running every flow — the safe default when we cannot
 * prove a narrower scope.
 */
export function matchFilesToRoutes(files: string[], routeMap?: RouteMap): string[] {
  const out = new Set<string>();
  const hasCustom = routeMap && Object.keys(routeMap).length > 0;

  for (const file of files) {
    let matched = false;
    if (hasCustom) {
      for (const [pattern, routes] of Object.entries(routeMap!)) {
        if (globToRegex(pattern).test(file)) {
          for (const r of routes) out.add(r);
          matched = true;
        }
      }
    } else {
      for (const heuristic of DEFAULT_HEURISTICS) {
        const m = file.match(heuristic.match);
        if (m && m[1] !== undefined) {
          for (const r of heuristic.derive(m[1])) out.add(r);
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      // Safe default: unknown file → assume it could affect anything.
      out.add(ALL_ROUTES);
    }
  }

  return Array.from(out);
}

/**
 * Extract every `goto` URL referenced by a flow's steps (including nested
 * iframe steps), so we can match them against the derived route set.
 */
function collectGotoUrls(steps: Step[]): string[] {
  const urls: string[] = [];
  for (const step of steps) {
    if ('goto' in step && typeof step.goto === 'string') urls.push(step.goto);
    if ('iframe' in step && step.iframe?.steps) {
      urls.push(...collectGotoUrls(step.iframe.steps));
    }
  }
  return urls;
}

/**
 * Return the path portion of a URL. Accepts absolute URLs (`https://x/a/b`)
 * and already-relative paths (`/a/b`, `a/b`). Fragments and query strings
 * are stripped so matching is path-only.
 */
function urlPath(raw: string): string {
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).pathname;
  } catch {
    /* fall through */
  }
  const noFrag = raw.split('#')[0] ?? '';
  const noQuery = noFrag.split('?')[0] ?? '';
  if (noQuery.startsWith('/')) return noQuery;
  return '/' + noQuery;
}

/**
 * Return `true` when `path` matches `pattern`. Patterns may be glob-style
 * (containing `*`) or plain strings that match when `path` either equals
 * or starts with the pattern (treating it as a prefix scope).
 */
function routeMatchesPath(pattern: string, path: string): boolean {
  if (pattern.includes('*')) return globToRegex(pattern).test(path);
  if (path === pattern) return true;
  // Treat configured pattern as a prefix so `/checkout` matches `/checkout/step/1`.
  if (pattern.endsWith('/')) return path.startsWith(pattern);
  return path === pattern || path.startsWith(pattern + '/');
}

/**
 * Filter `flows` to those whose `goto` steps visit at least one of the
 * supplied `routes`. If `routes` contains {@link ALL_ROUTES} or is empty,
 * returns the input unchanged (safe default — run everything).
 */
export function filterFlowsByRoutes(flows: Flow[], routes: string[]): Flow[] {
  if (routes.length === 0) return flows;
  if (routes.includes(ALL_ROUTES)) return flows;

  return flows.filter((flow) => {
    const urls = collectGotoUrls(flow.steps);
    // Flows with no goto steps can't be scoped — keep them (safe default).
    if (urls.length === 0) return true;
    return urls.some((u) => {
      const p = urlPath(u);
      return routes.some((r) => routeMatchesPath(r, p));
    });
  });
}

/**
 * Human-readable summary line printed by the CLI when `--changed` /
 * `--since` narrows the flow set.
 */
export function summarizeChangedRun(kept: number, total: number): string {
  const skipped = total - kept;
  return `Running ${kept} of ${total} flows (${skipped} skipped via --changed)`;
}
