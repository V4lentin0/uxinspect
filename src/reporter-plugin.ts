import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { InspectResult } from './types.js';

export interface ReporterContext {
  outDir: string;
  startedAt: Date;
  finishedAt: Date;
  env?: Record<string, string | undefined>;
}

export interface Reporter {
  name: string;
  version?: string;
  onStart?(ctx: ReporterContext): Promise<void> | void;
  onResult(result: InspectResult, ctx: ReporterContext): Promise<void> | void;
  onFinish?(ctx: ReporterContext): Promise<void> | void;
  onError?(err: unknown, ctx: ReporterContext): Promise<void> | void;
}

export interface ReporterRunStatus {
  name: string;
  passed: boolean;
  error?: string;
}

function isReporter(value: unknown): value is Reporter {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === 'string' &&
    candidate.name.length > 0 &&
    typeof candidate.onResult === 'function'
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}

export class ReporterRegistry {
  private readonly reporters: Map<string, Reporter> = new Map();

  register(reporter: Reporter): void {
    if (!isReporter(reporter)) {
      throw new Error('Invalid reporter: requires "name" and "onResult"');
    }
    const id = reporter.name.toLowerCase();
    if (this.reporters.has(id)) {
      throw new Error(`Reporter already registered: ${reporter.name}`);
    }
    this.reporters.set(id, reporter);
  }

  unregister(name: string): void {
    this.reporters.delete(name.toLowerCase());
  }

  list(): Reporter[] {
    return Array.from(this.reporters.values());
  }

  get(name: string): Reporter | undefined {
    return this.reporters.get(name.toLowerCase());
  }
}

export const defaultReporterRegistry = new ReporterRegistry();

async function safeInvoke(
  fn: (() => Promise<void> | void) | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!fn) return { ok: true };
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

async function invokeOnError(
  reporter: Reporter,
  err: unknown,
  ctx: ReporterContext,
): Promise<void> {
  if (!reporter.onError) return;
  try {
    await reporter.onError(err, ctx);
  } catch {
    // onError must never throw out of runReporters
  }
}

export async function runReporters(
  result: InspectResult,
  ctx: ReporterContext,
  registry: ReporterRegistry = defaultReporterRegistry,
): Promise<ReporterRunStatus[]> {
  const reporters = registry.list();
  const statuses: ReporterRunStatus[] = [];

  for (const reporter of reporters) {
    const status: ReporterRunStatus = { name: reporter.name, passed: true };

    const startRes = await safeInvoke(
      reporter.onStart ? () => reporter.onStart!(ctx) : undefined,
    );
    if (!startRes.ok) {
      status.passed = false;
      status.error = startRes.error;
      await invokeOnError(reporter, new Error(startRes.error), ctx);
      statuses.push(status);
      continue;
    }

    const resultRes = await safeInvoke(() => reporter.onResult(result, ctx));
    if (!resultRes.ok) {
      status.passed = false;
      status.error = resultRes.error;
      await invokeOnError(reporter, new Error(resultRes.error), ctx);
    }

    const finishRes = await safeInvoke(
      reporter.onFinish ? () => reporter.onFinish!(ctx) : undefined,
    );
    if (!finishRes.ok) {
      status.passed = false;
      status.error = status.error
        ? `${status.error}; onFinish: ${finishRes.error}`
        : finishRes.error;
      await invokeOnError(reporter, new Error(finishRes.error), ctx);
    }

    statuses.push(status);
  }

  return statuses;
}

export async function loadReporterFromPath(p: string): Promise<Reporter> {
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  const url = pathToFileURL(abs).href;
  const mod: unknown = await import(url);
  if (mod === null || typeof mod !== 'object') {
    throw new Error(`Reporter module did not export an object: ${p}`);
  }
  const record = mod as Record<string, unknown>;
  const candidate = record.default ?? record.reporter ?? record;
  if (!isReporter(candidate)) {
    throw new Error(
      `Reporter module at ${p} must default-export a Reporter with "name" and "onResult"`,
    );
  }
  return candidate;
}

export const jsonFileReporter: Reporter = {
  name: 'json-file',
  version: '1.0.0',
  onResult: async (result, ctx) => {
    await fs.mkdir(ctx.outDir, { recursive: true });
    const target = path.join(ctx.outDir, 'result.json');
    await fs.writeFile(target, JSON.stringify(result, null, 2), 'utf8');
  },
};
