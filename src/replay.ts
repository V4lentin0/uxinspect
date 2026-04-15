import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Page } from 'playwright';

const REPLAY_FILE_VERSION = 1 as const;

/**
 * Shape of a single rrweb event. We don't import rrweb's types because the
 * script runs inside the browser; on the Node side we treat events as opaque
 * JSON objects and simply forward them to disk. Each event has a numeric type
 * and timestamp — we capture those two to compute flow duration.
 */
export interface ReplayEvent {
  type: number;
  data: unknown;
  timestamp: number;
  [extra: string]: unknown;
}

export interface ReplayFile {
  version: typeof REPLAY_FILE_VERSION;
  flowName: string;
  startedAt: string;
  durationMs: number;
  events: ReplayEvent[];
}

export interface ReplayHandle {
  /** Flow name this handle is bound to. */
  readonly flowName: string;
  /** Absolute path the events will be written to on flush. */
  readonly outputPath: string;
  /** Number of events buffered so far. */
  events(): ReadonlyArray<ReplayEvent>;
  /**
   * Flush buffered events to disk as JSON. Safe to call even when zero events
   * were captured (writes a file with an empty events array so consumers can
   * still link to it). Returns the absolute path written.
   */
  flush(): Promise<string>;
  /**
   * Detach exposed function + init script (best-effort; most useful in tests
   * when the page outlives the flow).
   */
  detach(): Promise<void>;
}

/**
 * Filesystem-safe version of the flow name used in the output filename.
 */
export function sanitizeFlowName(name: string): string {
  const trimmed = name.trim();
  const safe = trimmed.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe.length > 0 ? safe.toLowerCase() : 'flow';
}

/**
 * Compute the output path for a replay file. Exposed for testing + for
 * callers that want to pre-compute the path before the flow runs.
 */
export function replayFilePath(outDir: string, flowName: string, timestamp: number): string {
  return path.join(path.resolve(outDir), 'replays', `${sanitizeFlowName(flowName)}-${timestamp}.json`);
}

/**
 * Resolve the on-disk location of the rrweb UMD bundle that we inject into
 * the page. Uses `createRequire` so it works when this module is loaded as
 * ESM from `dist/`. Falls back to `undefined` if the package is missing — the
 * caller treats that as a fatal config error.
 */
function resolveRrwebBundle(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    // rrweb's package exports don't expose package.json; resolve the main
    // entry and walk up to the package root so we can grab the UMD bundle
    // instead (which is what `addInitScript` needs — a plain script blob).
    const mainPath = require.resolve('rrweb');
    // mainPath is e.g. .../node_modules/rrweb/dist/rrweb.cjs — the package
    // root is two dirs above.
    const distDir = path.dirname(mainPath);
    return path.join(distDir, 'rrweb.umd.min.cjs');
  } catch {
    return undefined;
  }
}

async function readRrwebBundle(): Promise<string> {
  const bundlePath = resolveRrwebBundle();
  if (!bundlePath) {
    throw new Error('rrweb package not found. Install it with: npm install rrweb');
  }
  return fs.readFile(bundlePath, 'utf8');
}

/**
 * Attach replay capture to a Playwright page. Must be called BEFORE the first
 * navigation so the init script runs on the initial document. Returns a
 * handle whose `.flush()` method serializes the buffered rrweb events to
 * `<outDir>/replays/<flow>-<unix-ts>.json`.
 */
export async function attachReplayCapture(
  page: Page,
  flowName: string,
  outDir: string,
): Promise<ReplayHandle> {
  const bundle = await readRrwebBundle();
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const timestamp = startedAtDate.getTime();
  const outputPath = replayFilePath(outDir, flowName, timestamp);

  const buffer: ReplayEvent[] = [];
  let flushed = false;

  const pushFn = '__uxiReplayPush';

  await page.exposeFunction(pushFn, (event: ReplayEvent) => {
    // Drop events that arrive after flush to avoid mutating the written file.
    if (flushed) return;
    if (event && typeof event === 'object' && typeof event.type === 'number') {
      buffer.push(event);
    }
  });

  // Inject rrweb bundle + a tiny bootstrap that starts `record()` and forwards
  // each emitted event to the exposed Node-side function. We guard against
  // double-injection (same-origin navigations re-execute init scripts on some
  // conditions) using a sentinel flag on `window`.
  const initScript = `(() => {
    if (window.__uxiReplayStarted) return;
    window.__uxiReplayStarted = true;
    try {
${bundle}
      const rrweb = (typeof window !== 'undefined' && window.rrweb) || (typeof self !== 'undefined' && self.rrweb);
      if (!rrweb || typeof rrweb.record !== 'function') return;
      const push = window.${pushFn};
      if (typeof push !== 'function') return;
      rrweb.record({
        emit(event) {
          try { push(event); } catch (_err) { /* page unloaded */ }
        },
        recordCanvas: false,
        collectFonts: false,
      });
    } catch (_err) {
      // Never let rrweb boot errors break the flow.
    }
  })();`;

  await page.addInitScript({ content: initScript });

  const flush = async (): Promise<string> => {
    if (flushed) return outputPath;
    flushed = true;
    const endedAt = Date.now();
    const payload: ReplayFile = {
      version: REPLAY_FILE_VERSION,
      flowName,
      startedAt,
      durationMs: Math.max(0, endedAt - timestamp),
      events: buffer.slice(),
    };
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(payload));
    return outputPath;
  };

  const detach = async (): Promise<void> => {
    // Playwright doesn't expose a way to remove a single init script or
    // unbind an exposed function; the best we can do is no-op subsequent
    // pushes (handled via the `flushed` flag) and let the page GC the
    // binding on close.
  };

  return {
    flowName,
    outputPath,
    events: () => buffer,
    flush,
    detach,
  };
}
