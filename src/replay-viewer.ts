import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Single-file, offline-capable rrweb replay viewer.
 *
 * Generates a self-contained HTML document with the rrweb-player UMD bundle
 * and stylesheet inlined from the locally installed `rrweb-player` package.
 * Replay events are injected as `window.__REPLAY_EVENTS__`. No network calls
 * are made by the viewer at runtime.
 */

export interface ReplayViewerOptions {
  /** Title shown in the browser tab and viewer header. */
  title?: string;
  /** Filesystem path the events were loaded from (shown in header). */
  sourcePath?: string;
  /** Initial player width in pixels (default 1024). */
  width?: number;
  /** Initial player height in pixels (default 576). */
  height?: number;
  /** Auto-play on load (default true). */
  autoPlay?: boolean;
  /** Show controller bar (default true). */
  showController?: boolean;
}

interface RrwebAssets {
  js: string;
  css: string;
  version: string;
}

let cachedAssets: RrwebAssets | null = null;

async function loadRrwebPlayerAssets(): Promise<RrwebAssets> {
  if (cachedAssets) return cachedAssets;

  // Resolve `rrweb-player/package.json` from this module's location so we can
  // find `dist/index.js` + `dist/style.css` in node_modules without depending
  // on cwd. Fall back to `process.cwd()` for development scenarios.
  const here = fileURLToPath(import.meta.url);
  const candidates = [here, path.join(process.cwd(), 'package.json')];

  let pkgPath: string | null = null;
  let lastErr: unknown;
  for (const anchor of candidates) {
    try {
      const req = createRequire(anchor);
      pkgPath = req.resolve('rrweb-player/package.json');
      break;
    } catch (e) {
      lastErr = e;
    }
  }

  if (!pkgPath) {
    throw new Error(
      `Cannot resolve rrweb-player. Run \`npm install\` to install the replay viewer dependency.\n` +
        `(${(lastErr as Error)?.message ?? 'module not found'})`,
    );
  }

  const distDir = path.join(path.dirname(pkgPath), 'dist');
  const jsPath = path.join(distDir, 'index.js');
  const cssPath = path.join(distDir, 'style.css');

  const [pkgRaw, js, css] = await Promise.all([
    fs.readFile(pkgPath, 'utf8'),
    fs.readFile(jsPath, 'utf8'),
    fs.readFile(cssPath, 'utf8'),
  ]);

  const version = (JSON.parse(pkgRaw) as { version?: string }).version ?? 'unknown';
  cachedAssets = { js, css, version };
  return cachedAssets;
}

/** Escape a string for safe embedding inside `<script>...</script>`. */
function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render a single-file HTML viewer for an array of rrweb events.
 * The output is fully self-contained: no CDN, no fetch, no external assets.
 */
export async function renderReplayViewer(
  events: unknown[],
  opts: ReplayViewerOptions = {},
): Promise<string> {
  if (!Array.isArray(events)) {
    throw new Error('renderReplayViewer: events must be an array of rrweb events');
  }
  if (events.length < 2) {
    throw new Error(
      `renderReplayViewer: need at least 2 rrweb events to replay (got ${events.length})`,
    );
  }

  const assets = await loadRrwebPlayerAssets();

  const title = opts.title ?? 'uxinspect replay';
  const source = opts.sourcePath ?? '';
  const width = Math.max(320, Math.floor(opts.width ?? 1024));
  const height = Math.max(240, Math.floor(opts.height ?? 576));
  const autoPlay = opts.autoPlay !== false;
  const showController = opts.showController !== false;
  const eventCount = events.length;

  const eventsLiteral = safeJsonForScript(events);
  const propsLiteral = safeJsonForScript({
    width,
    height,
    autoPlay,
    showController,
    skipInactive: true,
  });

  const sourceMetaHtml = source
    ? `<span>source <code>${escapeHtml(source)}</code></span>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src blob:;" />
<title>${escapeHtml(title)}</title>
<style>
  /* Design tokens — GCP / Cloudflare light theme */
  :root {
    --bg: #FAFAFA;
    --surface: #FFFFFF;
    --text: #1D1D1F;
    --muted: #6B7280;
    --border: #E5E7EB;
    --primary: #10B981;
    --primary-bg: #ECFDF5;
    --secondary: #3B82F6;
    --secondary-bg: #EFF6FF;
    --danger-bg: #FEF2F2;
    --danger: #B91C1C;
    --shadow: 0 1px 2px rgba(17, 24, 39, 0.04), 0 1px 3px rgba(17, 24, 39, 0.06);
    --radius: 8px;
    --radius-sm: 6px;
    --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: var(--font); -webkit-font-smoothing: antialiased; }
  body { min-height: 100vh; display: flex; flex-direction: column; }
  header.app {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 14px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  header.app .brand {
    display: flex;
    align-items: baseline;
    gap: 12px;
  }
  header.app h1 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  header.app .tag {
    font-size: 11px;
    font-weight: 500;
    color: var(--primary);
    background: var(--primary-bg);
    padding: 3px 8px;
    border-radius: 999px;
    border: 1px solid #A7F3D0;
  }
  header.app .meta {
    font-size: 12px;
    color: var(--muted);
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
  }
  header.app .meta span code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--text);
    background: var(--bg);
    padding: 2px 6px;
    border-radius: 4px;
    border: 1px solid var(--border);
    font-size: 11px;
  }
  main {
    flex: 1;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 24px;
  }
  .player-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 16px;
    max-width: 100%;
    overflow: auto;
  }
  #player {
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .fallback {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 32px;
    max-width: 520px;
    text-align: center;
  }
  .fallback.error {
    border-color: #FCA5A5;
    background: var(--danger-bg);
    color: var(--danger);
  }
  .fallback h2 { margin: 0 0 8px; font-size: 16px; font-weight: 600; }
  .fallback p { margin: 0; font-size: 13px; }
  footer.app {
    padding: 12px 24px;
    border-top: 1px solid var(--border);
    background: var(--surface);
    font-size: 11px;
    color: var(--muted);
    text-align: center;
  }
  footer.app code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--text);
  }

  /* rrweb-player overrides — flatten dark UI to fit GCP light theme */
  .replayer-wrapper { background: var(--surface); }
  .rr-player { box-shadow: none !important; }
  .rr-controller { background: var(--surface) !important; color: var(--text) !important; border-top: 1px solid var(--border) !important; }
  .rr-controller__btns button { color: var(--text) !important; }
  .rr-controller__btns button:hover { color: var(--primary) !important; }
  .rr-progress { background: var(--border) !important; }
  .rr-progress__step { background: var(--primary) !important; }
  .rr-progress__handler { background: var(--primary) !important; border-color: var(--surface) !important; }
  .rr-timeline__time { color: var(--muted) !important; }

  /* Bundled rrweb-player stylesheet (verbatim) */
${assets.css}
</style>
</head>
<body>
<header class="app">
  <div class="brand">
    <h1>uxinspect</h1>
    <span class="tag">replay</span>
  </div>
  <div class="meta">
    <span>events <code>${eventCount}</code></span>
    ${sourceMetaHtml}
    <span>player <code>rrweb-player ${escapeHtml(assets.version)}</code></span>
  </div>
</header>
<main>
  <div class="player-card">
    <div id="player"></div>
    <div id="fallback" class="fallback error" hidden>
      <h2 id="fallback-title">Could not start replay</h2>
      <p id="fallback-msg"></p>
    </div>
  </div>
</main>
<footer class="app">
  Offline replay viewer. Generated by <code>uxinspect replay</code>.
</footer>

<script>window.__REPLAY_EVENTS__ = ${eventsLiteral};</script>
<script>window.__REPLAY_PROPS__ = ${propsLiteral};</script>
<script>
${assets.js}
</script>
<script>
(function () {
  var mount = document.getElementById('player');
  var fallback = document.getElementById('fallback');
  var fallbackMsg = document.getElementById('fallback-msg');
  function fail(msg) {
    if (mount) mount.style.display = 'none';
    if (fallback) fallback.hidden = false;
    if (fallbackMsg) fallbackMsg.textContent = String(msg);
  }
  try {
    if (typeof window.rrwebPlayer !== 'function') {
      fail('rrweb-player did not register on window. The bundle may be corrupt.');
      return;
    }
    var events = window.__REPLAY_EVENTS__;
    var opts = window.__REPLAY_PROPS__ || {};
    if (!Array.isArray(events) || events.length < 2) {
      fail('Need at least 2 rrweb events to replay (got ' + (Array.isArray(events) ? events.length : 0) + ').');
      return;
    }
    new window.rrwebPlayer({
      target: mount,
      props: {
        events: events,
        width: opts.width,
        height: opts.height,
        autoPlay: opts.autoPlay,
        showController: opts.showController,
        skipInactive: opts.skipInactive,
      },
    });
  } catch (e) {
    fail((e && e.message) ? String(e.message) : 'Unknown error.');
  }
})();
</script>
</body>
</html>
`;
}

/**
 * Read a JSON file containing rrweb events and return a self-contained HTML
 * viewer string. Accepts either a bare array of events or an object with an
 * `events` field (matches `src/replay.ts` capture format).
 */
export async function renderReplayViewerFromFile(
  jsonPath: string,
  opts: ReplayViewerOptions = {},
): Promise<string> {
  const abs = path.resolve(jsonPath);
  const raw = await fs.readFile(abs, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${abs}: invalid JSON — ${(e as Error).message}`);
  }
  const events = extractEvents(parsed);
  return renderReplayViewer(events, {
    ...opts,
    sourcePath: opts.sourcePath ?? abs,
    title: opts.title ?? `uxinspect replay — ${path.basename(abs)}`,
  });
}

function extractEvents(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.events)) return obj.events as unknown[];
    if (Array.isArray(obj.replay)) return obj.replay as unknown[];
  }
  throw new Error('replay JSON must be an array of rrweb events or an object with an `events` array');
}

/**
 * Convenience helper: render the viewer and write it to disk.
 * Returns the absolute path of the generated HTML file.
 */
export async function writeReplayViewer(
  jsonPath: string,
  outPath: string,
  opts: ReplayViewerOptions = {},
): Promise<string> {
  const html = await renderReplayViewerFromFile(jsonPath, opts);
  const abs = path.resolve(outPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, html, 'utf8');
  return abs;
}
