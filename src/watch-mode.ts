import { watch, type FSWatcher } from 'node:fs';
import type { InspectConfig, InspectResult } from './types.js';

export interface WatchModeOptions {
  config: InspectConfig;
  paths: string[];
  debounceMs?: number;
  onResult?: (result: InspectResult) => void;
  onError?: (err: Error) => void;
}

const IGNORE_SUBSTRINGS = [
  '/node_modules/',
  '/.git/',
  '/dist/',
  '/uxinspect-report/',
  '/uxinspect-baselines/',
  '/uxinspect-smoke-report/',
];

const IGNORE_EXTENSIONS = ['.log', '.tmp'];

function shouldIgnore(filename: string | null | undefined): boolean {
  if (!filename) return false;
  const normalized = filename.replace(/\\/g, '/');
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`;
  for (const sub of IGNORE_SUBSTRINGS) {
    if (prefixed.includes(sub)) return true;
  }
  for (const ext of IGNORE_EXTENSIONS) {
    if (normalized.endsWith(ext)) return true;
  }
  return false;
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(typeof err === 'string' ? err : JSON.stringify(err));
}

export async function runWatchMode(opts: WatchModeOptions): Promise<() => Promise<void>> {
  const { config, paths, debounceMs = 500, onResult, onError } = opts;

  const watchers: FSWatcher[] = [];
  let debounceTimer: NodeJS.Timeout | null = null;
  let isRunning = false;
  let queuedRun = false;
  let stopped = false;
  let currentRun: Promise<void> | null = null;

  const handleError = (err: unknown): void => {
    const error = toError(err);
    if (onError) {
      try {
        onError(error);
      } catch {
        // swallow handler error
      }
    } else {
      process.stdout.write(`[uxinspect:watch] error: ${error.message}\n`);
    }
  };

  const executeRun = async (): Promise<void> => {
    if (stopped) return;
    isRunning = true;
    try {
      process.stdout.write('[uxinspect:watch] change detected, running...\n');
      const started = Date.now();
      const { inspect } = await import('./index.js');
      const result = await inspect(config);
      const elapsed = Date.now() - started;
      if (onResult) {
        try {
          onResult(result);
        } catch (cbErr) {
          handleError(cbErr);
        }
      } else {
        process.stdout.write(
          `[uxinspect:watch] done in ${elapsed}ms — passed=${result.passed}\n`,
        );
      }
    } catch (err) {
      handleError(err);
    } finally {
      isRunning = false;
      if (queuedRun && !stopped) {
        queuedRun = false;
        currentRun = executeRun();
      } else {
        currentRun = null;
      }
    }
  };

  const triggerRun = (): void => {
    if (stopped) return;
    if (isRunning) {
      queuedRun = true;
      return;
    }
    currentRun = executeRun();
  };

  const scheduleRun = (): void => {
    if (stopped) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      triggerRun();
    }, debounceMs);
  };

  // Initial run before watching.
  currentRun = executeRun();

  // Set up watchers.
  for (const p of paths) {
    try {
      const watcher = watch(p, { recursive: true }, (_event, filename) => {
        if (stopped) return;
        if (shouldIgnore(filename)) return;
        scheduleRun();
      });
      watcher.on('error', (err) => {
        handleError(err);
      });
      watchers.push(watcher);
    } catch (err) {
      handleError(err);
    }
  }

  const stop = async (): Promise<void> => {
    if (stopped) {
      if (currentRun) await currentRun.catch(() => undefined);
      return;
    }
    stopped = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // ignore close errors
      }
    }
    watchers.length = 0;
    queuedRun = false;
    if (currentRun) {
      await currentRun.catch(() => undefined);
    }
  };

  return stop;
}
