import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { z } from 'zod';

import { resolveInsideCwd, resolveInsideUxinspect, PathSecurityError } from './safe-path.js';

/**
 * MCP tool surface for uxinspect.
 *
 * Each tool:
 *   1. accepts a small zod-validated input,
 *   2. pipes every path through the safe-path helpers,
 *   3. lazily imports the heavy uxinspect modules so `uxinspect-mcp --help`
 *      and `resources/list` remain fast,
 *   4. returns a structured JSON summary — never a raw Playwright trace or
 *      multi-megabyte HTML blob. Large artifacts are referenced by path.
 *
 * This module intentionally does NOT depend on the MCP SDK. It returns plain
 * `{ content, isError? }` envelopes so the host (index.ts) can register them
 * with any MCP transport (stdio / websocket / streamable-http) without the
 * tool bodies being coupled to SDK internals.
 */

// ---------------------------------------------------------------------------
// shared envelope
// ---------------------------------------------------------------------------

export interface ToolContent {
  type: 'text';
  text: string;
}
export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export interface ToolContext {
  cwd: string;
}

function ok(payload: unknown): ToolResult {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return {
    content: [{ type: 'text', text }],
    structuredContent: typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : { value: payload },
  };
}

function fail(err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text', text: `error: ${msg}` }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// uxinspect_run
// ---------------------------------------------------------------------------

export const runInputSchema = z.object({
  url: z.string().url().describe('URL to inspect'),
  config: z.string().optional().describe('Path to a uxinspect config (.ts/.js/.json), relative to cwd'),
  checks: z
    .object({
      a11y: z.boolean().optional(),
      perf: z.boolean().optional(),
      visual: z.boolean().optional(),
      seo: z.boolean().optional(),
      links: z.boolean().optional(),
      security: z.boolean().optional(),
      explore: z.boolean().optional(),
    })
    .partial()
    .optional()
    .describe('Audit toggles. Omit for defaults; pass {all:true} via config to enable every check.'),
  out: z.string().optional().describe('Report output dir (relative to cwd). Default: uxinspect-report/'),
  reporters: z.array(z.enum(['html', 'json', 'junit', 'sarif'])).optional(),
  budget: z.string().optional().describe('Path to a budget JSON, relative to cwd'),
});

export type RunInput = z.infer<typeof runInputSchema>;

async function runTool(input: RunInput, ctx: ToolContext): Promise<ToolResult> {
  try {
    const configPath = input.config ? resolveInsideCwd(input.config, ctx.cwd) : undefined;
    const budgetPath = input.budget ? resolveInsideCwd(input.budget, ctx.cwd) : undefined;
    const outDir = input.out ? resolveInsideCwd(input.out, ctx.cwd) : path.join(ctx.cwd, 'uxinspect-report');

    // Lazy-import to keep MCP boot fast and to avoid pulling Playwright into
    // transports that never call `uxinspect_run`.
    const { inspect } = await import('uxinspect');
    const { saveLastRun } = await import('uxinspect/dist/diff-run.js').catch(() => ({ saveLastRun: null as null | ((r: unknown, cwd?: string) => Promise<string>) }));

    const fileConfig = configPath ? await loadConfigFile(configPath) : {};
    const budget = budgetPath ? JSON.parse(await fs.readFile(budgetPath, 'utf8')) : undefined;

    const config = {
      ...(fileConfig as Record<string, unknown>),
      url: input.url,
      checks: input.checks,
      output: { dir: outDir },
      reporters: input.reporters ?? ['html', 'json'],
      budget,
    };

    const result = await (inspect as (c: unknown) => Promise<InspectResultShape>)(config);

    // Save last-run so `uxinspect_diff` with no args can find it.
    if (saveLastRun) {
      try { await saveLastRun(result, ctx.cwd); } catch { /* non-fatal */ }
    }

    return ok({
      passed: result.passed,
      durationMs: result.durationMs,
      reportPath: path.join(outDir, 'report.html'),
      jsonPath: path.join(outDir, 'report.json'),
      flows: (result.flows ?? []).map((f) => ({ name: f.name, passed: f.passed, error: f.error })),
      budgetViolations: result.budget ?? [],
      coverage: result.explore?.coverage ?? null,
    });
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// uxinspect_explore
// ---------------------------------------------------------------------------

export const exploreInputSchema = z.object({
  url: z.string().url().describe('URL to auto-explore (clicks everything, records coverage)'),
  maxClicks: z.number().int().positive().optional().describe('Ceiling on clicks; default uxinspect defaults'),
  out: z.string().optional().describe('Report output dir, relative to cwd'),
  headed: z.boolean().optional(),
});

export type ExploreInput = z.infer<typeof exploreInputSchema>;

async function exploreTool(input: ExploreInput, ctx: ToolContext): Promise<ToolResult> {
  try {
    const outDir = input.out ? resolveInsideCwd(input.out, ctx.cwd) : path.join(ctx.cwd, 'uxinspect-report');

    const { inspect } = await import('uxinspect');
    const config = {
      url: input.url,
      checks: { explore: true },
      explore: input.maxClicks ? { maxClicks: input.maxClicks } : undefined,
      output: { dir: outDir },
      reporters: ['html', 'json'] as const,
      headed: input.headed,
    };

    const result = await (inspect as (c: unknown) => Promise<InspectResultShape>)(config);

    return ok({
      url: input.url,
      coverage: result.explore?.coverage ?? null,
      heatmap: summariseHeatmap(result.explore?.heatmap),
      reportPath: path.join(outDir, 'report.html'),
    });
  } catch (e) {
    return fail(e);
  }
}

function summariseHeatmap(heatmap: unknown): { hotspots: Array<{ selector: string; clicks: number }>; totalClicks: number } | null {
  if (!heatmap || typeof heatmap !== 'object') return null;
  const entries = (heatmap as { entries?: Array<{ selector: string; clicks: number }> }).entries ?? [];
  const sorted = [...entries].sort((a, b) => b.clicks - a.clicks);
  return {
    hotspots: sorted.slice(0, 10),
    totalClicks: entries.reduce((n, e) => n + (e.clicks ?? 0), 0),
  };
}

// ---------------------------------------------------------------------------
// uxinspect_diff
// ---------------------------------------------------------------------------

export const diffInputSchema = z.object({
  baseline: z.string().describe('Baseline result JSON, relative to cwd'),
  current: z
    .string()
    .optional()
    .describe('Current result JSON, relative to cwd. Defaults to .uxinspect/last.json'),
});

export type DiffInput = z.infer<typeof diffInputSchema>;

async function diffTool(input: DiffInput, ctx: ToolContext): Promise<ToolResult> {
  try {
    const baselinePath = resolveInsideCwd(input.baseline, ctx.cwd);
    const diffMod = await import('uxinspect/dist/diff-run.js') as {
      diffResults: (before: unknown, after: unknown) => DiffSummaryShape;
      loadResult: (p: string) => Promise<unknown>;
      LAST_RUN_FILE: string;
    };
    const currentPath = input.current
      ? resolveInsideCwd(input.current, ctx.cwd)
      : resolveInsideCwd(diffMod.LAST_RUN_FILE, ctx.cwd);

    const [baseline, current] = await Promise.all([
      diffMod.loadResult(baselinePath),
      diffMod.loadResult(currentPath),
    ]);
    const summary = diffMod.diffResults(baseline, current);

    const regressions: Array<{ kind: string; detail: string }> = [];
    for (const f of summary.flows ?? []) {
      if (f.before === 'pass' && f.after === 'fail') regressions.push({ kind: 'flow', detail: `${f.name}: ${f.error ?? 'failed'}` });
    }
    for (const s of summary.scores ?? []) {
      if (s.delta < 0) regressions.push({ kind: 'score', detail: `${s.page} ${s.metric}: ${s.before} → ${s.after} (${s.delta})` });
    }
    for (const a of summary.a11yNew ?? []) {
      regressions.push({ kind: 'a11y-new', detail: `${a.page} ${a.ruleId} (${a.impact ?? 'unknown'})` });
    }

    return ok({
      baselinePath,
      currentPath,
      regressions,
      summary,
    });
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// uxinspect_replay
// ---------------------------------------------------------------------------

export const replayInputSchema = z.object({
  path: z.string().describe('rrweb replay JSON, relative to cwd'),
  title: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  port: z.number().int().positive().optional().describe('Port for the ephemeral HTTP viewer. Default: random free port.'),
});

export type ReplayInput = z.infer<typeof replayInputSchema>;

async function replayTool(input: ReplayInput, ctx: ToolContext): Promise<ToolResult> {
  try {
    const inputPath = resolveInsideCwd(input.path, ctx.cwd);
    const stat = await fs.stat(inputPath).catch(() => null);
    if (!stat?.isFile()) throw new Error(`replay JSON not found: ${inputPath}`);

    // Emit the viewer into .uxinspect/replays/ so it's safely inside the sandbox.
    const replaysDir = resolveInsideUxinspect(path.join('replays'), ctx.cwd);
    await fs.mkdir(replaysDir, { recursive: true });
    const outPath = path.join(replaysDir, `replay-${Date.now()}.html`);

    const viewerMod = await import('uxinspect/dist/replay-viewer.js') as {
      writeReplayViewer: (
        input: string,
        out: string,
        opts?: { width?: number; height?: number; title?: string; autoPlay?: boolean },
      ) => Promise<string>;
    };
    const htmlPath = await viewerMod.writeReplayViewer(inputPath, outPath, {
      width: input.width,
      height: input.height,
      title: input.title,
    });

    const url = await startEphemeralViewer(htmlPath, input.port);
    return ok({
      htmlPath,
      url,
      hint: 'URL is served from the MCP server process; it stays alive until the server exits.',
    });
  } catch (e) {
    return fail(e);
  }
}

/** tiny per-file HTTP server — enough for one IDE preview window. */
async function startEphemeralViewer(htmlPath: string, port?: number): Promise<string> {
  const server = http.createServer(async (req, res) => {
    if (!req.url || req.url === '/' || req.url === '/index.html') {
      const body = await fs.readFile(htmlPath);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port ?? 0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const chosen = typeof addr === 'object' && addr ? addr.port : port ?? 0;
  server.unref();
  return `http://127.0.0.1:${chosen}/`;
}

// ---------------------------------------------------------------------------
// uxinspect_history
// ---------------------------------------------------------------------------

export const historyInputSchema = z.object({
  source: z
    .string()
    .optional()
    .describe('SQLite DB or legacy JSON directory, relative to cwd. Default: .uxinspect/history.db'),
  limit: z.number().int().positive().max(500).optional().describe('Max runs to return. Default: 20'),
  metric: z
    .enum([
      'perf.score',
      'a11y.score',
      'click.count',
      'console.errors',
      'network.failures',
      'visual.diff.total',
      'flow.duration',
    ])
    .optional()
    .describe('If set, also return rolling anomalies for this metric.'),
});

export type HistoryInput = z.infer<typeof historyInputSchema>;

async function historyTool(input: HistoryInput, ctx: ToolContext): Promise<ToolResult> {
  try {
    const source = input.source
      ? resolveInsideCwd(input.source, ctx.cwd)
      : resolveInsideCwd(path.join('.uxinspect', 'history.db'), ctx.cwd);

    const limit = input.limit ?? 20;
    const hist = await import('uxinspect/dist/history-timeline.js') as {
      loadHistory: (s: string) => Promise<HistoryRunShape[]>;
      computeAnomalies: (runs: HistoryRunShape[], opts?: { threshold?: number; window?: number }) => AnomalyShape[];
    };

    const runs = await hist.loadHistory(source);
    const recent = runs.slice(-limit);
    const trend = recent.map((r) => ({
      runId: r.path,
      startedAt: r.result.startedAt ?? null,
      durationMs: r.result.durationMs ?? null,
      passed: !!r.result.passed,
      perfScore: perfScore(r.result),
      a11yScore: a11yScore(r.result),
    }));

    const anomalies = input.metric
      ? hist.computeAnomalies(runs).filter((a) => a.metric === input.metric)
      : [];

    return ok({
      source,
      totalRuns: runs.length,
      returned: recent.length,
      trend,
      anomalies,
    });
  } catch (e) {
    return fail(e);
  }
}

function perfScore(result: { pages?: Array<{ perf?: { scores?: { performance?: number } } }> }): number | null {
  const scores = (result.pages ?? []).map((p) => p.perf?.scores?.performance).filter((n): n is number => typeof n === 'number');
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}
function a11yScore(result: { pages?: Array<{ perf?: { scores?: { accessibility?: number } } }> }): number | null {
  const scores = (result.pages ?? []).map((p) => p.perf?.scores?.accessibility).filter((n): n is number => typeof n === 'number');
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

export interface ToolDef<I> {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType<I>;
  handler: (input: I, ctx: ToolContext) => Promise<ToolResult>;
}

export const TOOLS: ToolDef<unknown>[] = [
  {
    name: 'uxinspect_run',
    title: 'Run a uxinspect inspection',
    description:
      'Runs uxinspect against a URL with optional config/budget/reporters. Returns pass/fail summary, flow outcomes, budget violations, and the path to the generated HTML report.',
    inputSchema: runInputSchema,
    handler: runTool,
  } as ToolDef<unknown>,
  {
    name: 'uxinspect_explore',
    title: 'Auto-explore a URL',
    description:
      'Spawns a headless crawl that clicks every interactive element it finds, recording coverage and a heatmap of where users could possibly click.',
    inputSchema: exploreInputSchema,
    handler: exploreTool,
  } as ToolDef<unknown>,
  {
    name: 'uxinspect_diff',
    title: 'Diff two uxinspect results',
    description:
      'Compares a baseline result JSON against a current result (default: .uxinspect/last.json) and returns a list of regressions (failed flows, dropped scores, new a11y violations).',
    inputSchema: diffInputSchema,
    handler: diffTool,
  } as ToolDef<unknown>,
  {
    name: 'uxinspect_replay',
    title: 'Open an rrweb replay viewer',
    description:
      'Renders a standalone replay viewer for an rrweb JSON capture and serves it over localhost HTTP. Returns the viewer URL for the IDE to open.',
    inputSchema: replayInputSchema,
    handler: replayTool,
  } as ToolDef<unknown>,
  {
    name: 'uxinspect_history',
    title: 'Query uxinspect history',
    description:
      'Reads the SQLite history database (or legacy JSON directory) and returns the most recent N runs as a trend. Optionally computes rolling-window z-score anomalies for a chosen metric.',
    inputSchema: historyInputSchema,
    handler: historyTool,
  } as ToolDef<unknown>,
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function loadConfigFile(p: string): Promise<unknown> {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.json') return JSON.parse(await fs.readFile(p, 'utf8'));
  // TS/JS: defer to the host loader via dynamic import. This is a best-effort
  // path — if the user's Node can't import TS, they should pre-compile.
  const mod = (await import(p)) as { default?: unknown };
  return mod.default ?? mod;
}

// ---------------------------------------------------------------------------
// shape shims (kept minimal — main library owns the real types)
// ---------------------------------------------------------------------------

interface InspectResultShape {
  passed?: boolean;
  durationMs?: number;
  flows?: Array<{ name?: string; passed?: boolean; error?: string }>;
  budget?: Array<{ message: string }>;
  explore?: { coverage?: { percent: number; clicked: number; total: number }; heatmap?: unknown };
  startedAt?: string | number;
  pages?: Array<{ perf?: { scores?: { performance?: number; accessibility?: number } } }>;
}

interface DiffSummaryShape {
  flows?: Array<{ name: string; before: string; after: string; error?: string }>;
  scores?: Array<{ page: string; metric: string; before: number; after: number; delta: number }>;
  a11yNew?: Array<{ page: string; ruleId: string; impact?: string }>;
  [k: string]: unknown;
}

interface HistoryRunShape {
  path: string;
  result: InspectResultShape;
}

interface AnomalyShape {
  metric: string;
  runId: string;
  value: number;
  zScore: number;
  direction: 'regression' | 'improvement';
}

export { PathSecurityError };
