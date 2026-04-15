import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { Page } from 'playwright';

/**
 * rrweb-based replay capture. Injects rrweb into the page, collects DOM events
 * via record({ emit }), and writes them to .uxinspect/replays/<flow>-<ISO-ts>.json
 * on stop. Failures are non-fatal — they log a warning and return null.
 */

declare global {
  interface Window {
    __uxinspectRrwebEvents: unknown[];
    __uxinspectRrwebStop?: () => void;
    rrweb?: {
      record: (opts: { emit: (event: unknown) => void; checkoutEveryNms?: number }) => () => void;
    };
  }
}

const REPLAY_DIR_DEFAULT = '.uxinspect/replays';

export interface ReplaySession {
  flowName: string;
  page: Page;
  startedAt: string;
  baseDir: string;
  injected: boolean;
}

let rrwebSourceCache: string | null | undefined;

function loadRrwebSource(): string | null {
  if (rrwebSourceCache !== undefined) return rrwebSourceCache;
  const candidates = [
    'rrweb/dist/rrweb.umd.min.cjs',
    'rrweb/dist/rrweb.min.js',
    'rrweb/dist/rrweb.umd.js',
    'rrweb/dist/rrweb.js',
  ];
  // Resolve relative to this module, then walk up to find node_modules.
  const here = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
  const req = createRequire(here);
  for (const candidate of candidates) {
    try {
      const resolved = req.resolve(candidate);
      const src = fs.readFileSync(resolved, 'utf8');
      rrwebSourceCache = src;
      return src;
    } catch {
      // try next candidate
    }
  }
  rrwebSourceCache = null;
  return null;
}

function sanitizeFlowName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'flow';
}

function isoStampForFile(d: Date): string {
  // Replace characters that are problematic on common file systems.
  return d.toISOString().replace(/[:.]/g, '-');
}

/**
 * Start capturing rrweb events on the given page for the named flow.
 * Returns a session handle to pass to stopReplay(). Returns null if rrweb
 * could not be loaded or injected — capture is best-effort.
 */
export async function startReplay(
  page: Page,
  flowName: string,
  opts: { baseDir?: string } = {},
): Promise<ReplaySession | null> {
  const baseDir = opts.baseDir ?? REPLAY_DIR_DEFAULT;
  const startedAt = new Date().toISOString();
  const session: ReplaySession = {
    flowName,
    page,
    startedAt,
    baseDir,
    injected: false,
  };

  const src = loadRrwebSource();
  if (!src) {
    console.warn('[uxinspect/replay] rrweb not found in node_modules — replay capture disabled');
    return session;
  }

  const initScript = `
    (function() {
      try {
        if (window.__uxinspectRrwebInstalled) return;
        window.__uxinspectRrwebInstalled = true;
        window.__uxinspectRrwebEvents = window.__uxinspectRrwebEvents || [];
        ${src}
        if (window.rrweb && typeof window.rrweb.record === 'function') {
          var stop = window.rrweb.record({
            emit: function(event) {
              try { window.__uxinspectRrwebEvents.push(event); } catch (e) {}
            },
            checkoutEveryNms: 30000,
          });
          window.__uxinspectRrwebStop = stop;
        }
      } catch (e) {
        try { console.warn('[uxinspect/replay] inject failed:', e && e.message); } catch (_) {}
      }
    })();
  `;

  try {
    // Install on every future navigation in this context.
    await page.addInitScript(initScript);
    // Also inject into the current document if one is already loaded.
    try {
      await page.evaluate(initScript);
    } catch {
      // No document yet, or about:blank — addInitScript will handle the next nav.
    }
    session.injected = true;
  } catch (e) {
    console.warn(
      `[uxinspect/replay] failed to inject rrweb: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return session;
}

/**
 * Stop capture and write the events to .uxinspect/replays/<flow>-<ISO-ts>.json.
 * Returns the absolute path to the written file, or null if nothing captured.
 */
export async function stopReplay(session: ReplaySession | null): Promise<string | null> {
  if (!session) return null;
  if (!session.injected) return null;

  let events: unknown[] = [];
  try {
    events = await session.page.evaluate(() => {
      try {
        if (typeof window.__uxinspectRrwebStop === 'function') {
          window.__uxinspectRrwebStop();
        }
      } catch (e) {
        // ignore stop failure
      }
      const collected = Array.isArray(window.__uxinspectRrwebEvents)
        ? window.__uxinspectRrwebEvents.slice()
        : [];
      try {
        window.__uxinspectRrwebEvents = [];
      } catch (e) {
        // ignore
      }
      return collected;
    });
  } catch (e) {
    console.warn(
      `[uxinspect/replay] failed to collect events: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }

  if (!events || events.length === 0) {
    return null;
  }

  const dir = path.resolve(session.baseDir);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.warn(
      `[uxinspect/replay] failed to create ${dir}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }

  const stampedName = `${sanitizeFlowName(session.flowName)}-${isoStampForFile(new Date(session.startedAt))}.json`;
  const filePath = path.join(dir, stampedName);
  const payload = {
    flow: session.flowName,
    startedAt: session.startedAt,
    endedAt: new Date().toISOString(),
    eventCount: events.length,
    events,
  };

  try {
    fs.writeFileSync(filePath, JSON.stringify(payload), 'utf8');
  } catch (e) {
    console.warn(
      `[uxinspect/replay] failed to write ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }

  return filePath;
}
