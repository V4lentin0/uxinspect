import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Shape of a replay JSON file produced by src/replay.ts.
 * Fields are read loosely so older/newer captures still render.
 */
export interface ReplayFile {
  version?: number;
  flowName?: string;
  startedAt?: number | string;
  durationMs?: number;
  events: unknown[];
}

const require = createRequire(import.meta.url);

/**
 * Resolve the on-disk path of rrweb-player's distributed JS + CSS.
 * We copy from node_modules and concat into the output HTML so the
 * generated viewer is a single self-contained file — zero network
 * requests at view-time.
 */
function resolveRrwebPlayerAssets(): { js: string; css: string } {
  try {
    const pkgPath = require.resolve('rrweb-player/package.json');
    const dir = path.dirname(pkgPath);
    return {
      js: path.join(dir, 'dist', 'index.js'),
      css: path.join(dir, 'dist', 'style.css'),
    };
  } catch {
    throw new Error(
      'rrweb-player is not installed. Run: npm install rrweb-player',
    );
  }
}

async function readAssetContents(): Promise<{ js: string; css: string }> {
  const paths = resolveRrwebPlayerAssets();
  const [js, css] = await Promise.all([
    fs.readFile(paths.js, 'utf8'),
    fs.readFile(paths.css, 'utf8'),
  ]);
  return { js, css };
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
 * Serialize arbitrary JSON for safe embedding inside a <script> tag.
 * `</script` inside strings would otherwise terminate the block early;
 * line/paragraph separators can break JS parsers too.
 */
function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${s}s`;
}

function formatTimestamp(ts: number | string | undefined): string {
  if (ts === undefined || ts === null || ts === '') return 'unknown';
  const n = typeof ts === 'number' ? ts : Date.parse(String(ts));
  if (!Number.isFinite(n) || n <= 0) return String(ts);
  return new Date(n).toISOString();
}

export interface ReplayViewerOptions {
  /** Pre-read rrweb-player assets — injected for testing or advanced use. */
  assets?: { js: string; css: string };
  /** Pre-parsed replay data — skip reading the file when provided. */
  replay?: ReplayFile;
}

/**
 * Generate a self-contained HTML page that plays back an rrweb
 * replay JSON file. All required JS and CSS are embedded inline;
 * the resulting file makes zero network requests.
 */
export async function generateReplayViewerHtml(
  replayJsonPath: string,
  options: ReplayViewerOptions = {},
): Promise<string> {
  const replay: ReplayFile =
    options.replay ??
    JSON.parse(await fs.readFile(replayJsonPath, 'utf8'));

  if (!replay || !Array.isArray(replay.events)) {
    throw new Error(
      `Invalid replay file at ${replayJsonPath}: expected { events: [] }`,
    );
  }

  const assets = options.assets ?? (await readAssetContents());

  const flowName = replay.flowName ?? path.basename(replayJsonPath, '.json');
  const startedAt = formatTimestamp(replay.startedAt);
  const durationMs = typeof replay.durationMs === 'number' ? replay.durationMs : 0;
  const duration = formatDuration(durationMs);
  const eventsJson = safeJsonForScript(replay.events);

  const title = `uxinspect replay — ${escapeHtml(flowName)}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${title}</title>
<style>
:root {
  --bg: #FAFAFA;
  --surface: #FFFFFF;
  --border: #E5E7EB;
  --text: #1D1D1F;
  --muted: #6B7280;
  --primary: #10B981;
  --primary-bg: #ECFDF5;
  --secondary: #3B82F6;
  --secondary-bg: #EFF6FF;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text);
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 14px; line-height: 1.5; }
header {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 16px 24px;
  display: flex;
  flex-wrap: wrap;
  gap: 16px 32px;
  align-items: center;
  box-shadow: 0 1px 2px rgba(0,0,0,0.03);
}
header h1 {
  font-size: 16px;
  margin: 0;
  font-weight: 600;
  letter-spacing: -0.01em;
}
header .meta { display: flex; gap: 24px; flex-wrap: wrap; color: var(--muted); font-size: 13px; }
header .meta strong { color: var(--text); font-weight: 500; margin-left: 6px; }
header .pill {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--primary-bg);
  color: var(--primary);
  font-size: 12px;
  font-weight: 500;
}
main {
  display: flex;
  justify-content: center;
  padding: 24px;
}
.viewer-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  max-width: 1400px;
  width: 100%;
}
.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding: 12px 4px 16px;
  align-items: center;
  border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
}
.controls label {
  font-size: 13px;
  color: var(--muted);
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
.controls select,
.controls button {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
}
.controls select:hover,
.controls button:hover { border-color: var(--primary); }
.controls button.primary { background: var(--primary); color: #fff; border-color: var(--primary); }
.controls button.primary:hover { background: #0ea371; border-color: #0ea371; }
.controls input[type="checkbox"] { accent-color: var(--primary); }
#player-host { width: 100%; min-height: 400px; }
.empty {
  padding: 48px;
  text-align: center;
  color: var(--muted);
}
/* rrweb-player styles (inlined) */
${assets.css}
</style>
</head>
<body>
<header>
  <h1>uxinspect replay</h1>
  <div class="meta">
    <span>Flow: <strong>${escapeHtml(flowName)}</strong></span>
    <span>Started: <strong>${escapeHtml(startedAt)}</strong></span>
    <span>Duration: <strong>${escapeHtml(duration)}</strong></span>
    <span>Events: <strong>${replay.events.length}</strong></span>
  </div>
  <span class="pill">offline</span>
</header>
<main>
  <div class="viewer-card">
    <div class="controls">
      <button id="btn-play" class="primary" type="button">Play / Pause</button>
      <label>Speed
        <select id="speed">
          <option value="0.5">0.5x</option>
          <option value="1" selected>1x</option>
          <option value="2">2x</option>
          <option value="4">4x</option>
        </select>
      </label>
      <label>
        <input id="skip-inactive" type="checkbox" checked />
        Skip inactivity
      </label>
      <button id="btn-restart" type="button">Restart</button>
    </div>
    <div id="player-host"></div>
  </div>
</main>
<script>/* rrweb-player bundle (inlined) */
${assets.js}
</script>
<script>
(function () {
  var events = ${eventsJson};
  var host = document.getElementById('player-host');
  function showMessage(msg) {
    while (host.firstChild) host.removeChild(host.firstChild);
    var div = document.createElement('div');
    div.className = 'empty';
    div.textContent = msg;
    host.appendChild(div);
  }
  if (!events || events.length < 2) {
    showMessage('No replay events captured. Record a flow first.');
    return;
  }
  var Player = (typeof rrwebPlayer === 'function') ? rrwebPlayer : (rrwebPlayer && rrwebPlayer.default);
  if (!Player) {
    showMessage('rrweb-player failed to load.');
    return;
  }
  var width = Math.max(600, Math.min(1280, (host.clientWidth || 1024) - 24));
  var player = new Player({
    target: host,
    props: {
      events: events,
      width: width,
      autoPlay: false,
      showController: true,
      skipInactive: true,
      speedOption: [0.5, 1, 2, 4],
    },
  });

  function playerCall(name) {
    var fn = player && player[name];
    if (typeof fn === 'function') { try { fn.call(player); } catch (_) {} }
  }

  document.getElementById('btn-play').addEventListener('click', function () {
    playerCall('toggle');
  });
  document.getElementById('btn-restart').addEventListener('click', function () {
    try { player.goto(0); } catch (_) {}
    try { player.play && player.play(); } catch (_) {}
  });
  document.getElementById('speed').addEventListener('change', function (e) {
    var v = Number(e.target.value) || 1;
    try { player.setSpeed && player.setSpeed(v); } catch (_) {}
  });
  document.getElementById('skip-inactive').addEventListener('change', function (e) {
    try { player.toggleSkipInactive && player.toggleSkipInactive(); }
    catch (_) {
      try { player.setConfig && player.setConfig({ skipInactive: !!e.target.checked }); } catch (_) {}
    }
  });
})();
</script>
</body>
</html>
`;
}

/**
 * Open a file path in the user's default application.
 * Prefers the `open` npm package when installed; falls back to a
 * platform-specific shell command and finally to just logging the path.
 */
export async function openInBrowser(filePath: string): Promise<boolean> {
  try {
    const mod: any = await import('open');
    const openFn = mod.default ?? mod;
    await openFn(filePath);
    return true;
  } catch {
    // fall through to native spawn
  }
  try {
    const { spawn } = await import('node:child_process');
    const plat = process.platform;
    let cmd: string;
    let args: string[];
    if (plat === 'darwin') { cmd = 'open'; args = [filePath]; }
    else if (plat === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '', filePath]; }
    else { cmd = 'xdg-open'; args = [filePath]; }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
