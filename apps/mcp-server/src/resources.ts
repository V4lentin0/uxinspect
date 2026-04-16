import { promises as fs } from 'node:fs';
import path from 'node:path';

import { resolveInsideCwd } from './safe-path.js';

/**
 * MCP resources exposed by the uxinspect server.
 *
 * URI scheme: `uxinspect://`
 *   uxinspect://reports/latest     — last run's HTML report
 *   uxinspect://flows              — list of flow files discovered in cwd
 *   uxinspect://history/recent     — summary of last 20 runs (JSON)
 *
 * Resources are read-only and must never escape `cwd` — every path goes
 * through {@link resolveInsideCwd}.
 */

export interface ResourceDescriptor {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}

export interface ResourceContents {
  uri: string;
  mimeType: string;
  /** text body for text/* resources */
  text?: string;
  /** base64 blob for binary resources */
  blob?: string;
}

export interface ResourceContext {
  cwd: string;
}

export const RESOURCES: ResourceDescriptor[] = [
  {
    uri: 'uxinspect://reports/latest',
    name: 'latest-report',
    title: 'Latest uxinspect HTML report',
    description: 'The HTML report produced by the most recent `uxinspect run` in this project.',
    mimeType: 'text/html',
  },
  {
    uri: 'uxinspect://flows',
    name: 'flows',
    title: 'Defined flow files',
    description: 'JSON list of flow definition files discovered in the current workspace.',
    mimeType: 'application/json',
  },
  {
    uri: 'uxinspect://history/recent',
    name: 'history-recent',
    title: 'Recent uxinspect runs',
    description: 'JSON summary of the last 20 runs (pass/fail, duration, perf/a11y scores).',
    mimeType: 'application/json',
  },
];

export async function readResource(uri: string, ctx: ResourceContext): Promise<ResourceContents> {
  switch (uri) {
    case 'uxinspect://reports/latest':
      return readLatestReport(ctx);
    case 'uxinspect://flows':
      return readFlows(ctx);
    case 'uxinspect://history/recent':
      return readRecentHistory(ctx);
    default:
      throw new Error(`unknown resource URI: ${uri}`);
  }
}

// ---------------------------------------------------------------------------
// latest report
// ---------------------------------------------------------------------------

async function readLatestReport(ctx: ResourceContext): Promise<ResourceContents> {
  // Try common output dirs in priority order. We never walk outside cwd.
  const candidates = ['uxinspect-report/report.html', '.uxinspect/report.html', 'report.html'];
  for (const rel of candidates) {
    const abs = resolveInsideCwd(rel, ctx.cwd);
    const stat = await fs.stat(abs).catch(() => null);
    if (stat?.isFile()) {
      const text = await fs.readFile(abs, 'utf8');
      return { uri: 'uxinspect://reports/latest', mimeType: 'text/html', text };
    }
  }
  return {
    uri: 'uxinspect://reports/latest',
    mimeType: 'text/html',
    text: '<!doctype html><title>uxinspect</title><p>No report found. Run <code>uxinspect_run</code> first.</p>',
  };
}

// ---------------------------------------------------------------------------
// flows
// ---------------------------------------------------------------------------

async function readFlows(ctx: ResourceContext): Promise<ResourceContents> {
  const files = await discoverFlows(ctx.cwd);
  return {
    uri: 'uxinspect://flows',
    mimeType: 'application/json',
    text: JSON.stringify({ flows: files }, null, 2),
  };
}

/**
 * Walks `cwd` looking for files named `*.flow.{ts,js,json}` or anything under
 * a `flows/` directory. Intentionally skips `node_modules`, `dist`, and dot
 * directories other than `.uxinspect/`.
 */
async function discoverFlows(cwd: string): Promise<Array<{ path: string; name: string }>> {
  const out: Array<{ path: string; name: string }> = [];
  const visited = new Set<string>();
  const maxDepth = 4;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    if (visited.has(dir)) return;
    visited.add(dir);
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      if (entry.name.startsWith('.') && entry.name !== '.uxinspect') continue;
      const abs = path.join(dir, entry.name);
      // Safety: resolveInsideCwd rejects escapes (symlinks pointing outside).
      let safeAbs: string;
      try { safeAbs = resolveInsideCwd(path.relative(cwd, abs), cwd); }
      catch { continue; }

      if (entry.isDirectory()) {
        await walk(safeAbs, depth + 1);
      } else if (entry.isFile()) {
        const rel = path.relative(cwd, safeAbs);
        const isFlowFile =
          /\.flow\.(ts|js|mjs|cjs|json)$/.test(entry.name) ||
          rel.split(path.sep).includes('flows');
        if (isFlowFile) {
          out.push({ path: rel, name: entry.name.replace(/\.[^.]+$/, '') });
        }
      }
    }
  }

  await walk(cwd, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// recent history
// ---------------------------------------------------------------------------

async function readRecentHistory(ctx: ResourceContext): Promise<ResourceContents> {
  const defaultDb = resolveInsideCwd(path.join('.uxinspect', 'history.db'), ctx.cwd);
  const legacyDir = resolveInsideCwd('.uxinspect', ctx.cwd);

  const exists = async (p: string): Promise<boolean> => !!(await fs.stat(p).catch(() => null));

  let source: string | null = null;
  if (await exists(defaultDb)) source = defaultDb;
  else if (await exists(legacyDir)) source = legacyDir;

  if (!source) {
    return {
      uri: 'uxinspect://history/recent',
      mimeType: 'application/json',
      text: JSON.stringify({ runs: [], note: 'No history yet. Run uxinspect at least once.' }, null, 2),
    };
  }

  try {
    const hist = await import('uxinspect/dist/history-timeline.js') as {
      loadHistory: (s: string) => Promise<Array<{ path: string; result: RunResult }>>;
    };
    const runs = await hist.loadHistory(source);
    const recent = runs.slice(-20).map((r) => ({
      runId: r.path,
      startedAt: r.result.startedAt ?? null,
      durationMs: r.result.durationMs ?? null,
      passed: !!r.result.passed,
      flowsPassed: (r.result.flows ?? []).filter((f) => f.passed).length,
      flowsFailed: (r.result.flows ?? []).filter((f) => !f.passed).length,
    }));
    return {
      uri: 'uxinspect://history/recent',
      mimeType: 'application/json',
      text: JSON.stringify({ source, runs: recent }, null, 2),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      uri: 'uxinspect://history/recent',
      mimeType: 'application/json',
      text: JSON.stringify({ runs: [], error: msg }, null, 2),
    };
  }
}

interface RunResult {
  startedAt?: string | number;
  durationMs?: number;
  passed?: boolean;
  flows?: Array<{ name?: string; passed?: boolean }>;
}
