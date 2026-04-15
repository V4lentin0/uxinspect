#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { inspect } from './index.js';
import { writeReplayViewer } from './replay-viewer.js';
import { diffResults, formatDiff, loadResult, saveLastRun, LAST_RUN_FILE } from './diff-run.js';
import type { InspectConfig } from './types.js';

const STARTER_CONFIG = `import type { InspectConfig } from 'uxinspect';

export default {
  url: 'https://example.com',
  viewports: [
    { name: 'desktop', width: 1280, height: 800 },
    { name: 'mobile', width: 375, height: 667 },
  ],
  flows: [
    {
      name: 'home',
      steps: [{ goto: 'https://example.com' }],
    },
  ],
  checks: {
    a11y: true,
    visual: true,
    perf: true,
    seo: true,
    links: true,
    security: true,
  },
  parallel: true,
  reporters: ['html', 'json', 'junit', 'sarif'],
} satisfies InspectConfig;
`;

const STARTER_BUDGET = `{
  "perf": { "performance": 80, "accessibility": 90, "seo": 90 },
  "metrics": { "lcpMs": 2500, "cls": 0.1, "tbtMs": 300 },
  "a11y": { "maxCritical": 0, "maxSerious": 0 },
  "visual": { "maxDiffRatio": 0.001 }
}
`;

const GITHUB_ACTION = `name: uxinspect

on:
  pull_request:
  push:
    branches: [main]

jobs:
  inspect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npx uxinspect run --config ./uxinspect.config.ts --budget ./uxinspect.budget.json --reporters html,json,junit,sarif
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: uxinspect-report
          path: uxinspect-report/
`;

const argv = await yargs(hideBin(process.argv))
  .scriptName('uxinspect')
  .usage('$0 <cmd> [args]')
  .command('run', 'Run an inspection', (y) =>
    y
      .option('url', { type: 'string', demandOption: true, describe: 'URL to inspect' })
      .option('config', { type: 'string', describe: 'Path to config file (.ts/.js/.json)' })
      .option('all', { type: 'boolean', describe: 'Enable every check' })
      .option('a11y', { type: 'boolean', describe: 'Run accessibility checks' })
      .option('perf', { type: 'boolean', describe: 'Run performance audit' })
      .option('visual', { type: 'boolean', describe: 'Run visual diff' })
      .option('explore', { type: 'boolean', describe: 'Auto-explore by clicking everything' })
      .option('seo', { type: 'boolean', describe: 'SEO audit (meta, OG, canonical)' })
      .option('links', { type: 'boolean', describe: 'Broken link crawler' })
      .option('pwa', { type: 'boolean', describe: 'PWA audit (manifest, service worker)' })
      .option('security', { type: 'boolean', describe: 'Security headers audit' })
      .option('retire', { type: 'boolean', describe: 'Detect outdated JS libraries with known vulnerabilities' })
      .option('dead-clicks', { type: 'boolean', describe: 'Detect non-interactive elements that appear clickable' })
      .option('disabled-buttons', { type: 'boolean', describe: 'Verify disabled buttons do not respond to clicks' })
      .option('touch-targets', { type: 'boolean', describe: 'Audit touch target sizes for mobile usability' })
      .option('keyboard', { type: 'boolean', describe: 'Keyboard navigation and focus trap audit' })
      .option('long-tasks', { type: 'boolean', describe: 'Detect long-running main-thread tasks' })
      .option('cls-timeline', { type: 'boolean', describe: 'Record Cumulative Layout Shift timeline' })
      .option('forms', { type: 'boolean', describe: 'Audit form accessibility and validation' })
      .option('form-behavior', { type: 'boolean', describe: 'Run the empty/invalid/valid submit cycle on each form' })
      .option('structured-data', { type: 'boolean', describe: 'Validate JSON-LD / structured data' })
      .option('passive-security', { type: 'boolean', describe: 'Passive security scan (headers, cookies, CSP)' })
      .option('console-errors', { type: 'boolean', describe: 'Capture browser console errors' })
      .option('sitemap', { type: 'boolean', describe: 'Validate sitemap.xml' })
      .option('redirects', { type: 'boolean', describe: 'Audit redirect chains' })
      .option('exposed-paths', { type: 'boolean', describe: 'Probe for exposed sensitive paths' })
      .option('tls', { type: 'boolean', describe: 'TLS / HTTPS configuration audit' })
      .option('crawl', { type: 'boolean', describe: 'Crawl site for additional pages' })
      .option('content-quality', { type: 'boolean', describe: 'Content quality audit (readability, grammar signals)' })
      .option('resource-hints', { type: 'boolean', describe: 'Audit preload / preconnect / dns-prefetch hints' })
      .option('mixed-content', { type: 'boolean', describe: 'Detect mixed HTTP/HTTPS content' })
      .option('compression', { type: 'boolean', describe: 'Audit response compression (gzip/brotli)' })
      .option('cache-headers', { type: 'boolean', describe: 'Audit cache-control and HTTP cache headers' })
      .option('cookie-banner', { type: 'boolean', describe: 'Detect consent / cookie banner presence' })
      .option('third-party', { type: 'boolean', describe: 'Audit third-party script impact' })
      .option('bundle-size', { type: 'boolean', describe: 'Audit JS/CSS bundle sizes' })
      .option('open-graph', { type: 'boolean', describe: 'Validate OpenGraph and Twitter card meta tags' })
      .option('robots-audit', { type: 'boolean', describe: 'Validate robots.txt' })
      .option('image-audit', { type: 'boolean', describe: 'Audit images (alt text, dimensions, formats)' })
      .option('webfonts', { type: 'boolean', describe: 'Audit web font loading and performance' })
      .option('motion-prefs', { type: 'boolean', describe: 'Audit prefers-reduced-motion respect' })
      .option('sri', { type: 'boolean', describe: 'Subresource Integrity audit on third-party scripts/styles' })
      .option('web-workers', { type: 'boolean', describe: 'Web Worker lifecycle and error audit' })
      .option('orphan-assets', { type: 'boolean', describe: 'Detect loaded assets with no DOM reference' })
      .option('inp', { type: 'boolean', describe: 'Interaction-to-Next-Paint audit' })
      .option('lcp-element', { type: 'boolean', describe: 'Identify the Largest Contentful Paint element' })
      .option('cls-culprit', { type: 'boolean', describe: 'Identify DOM nodes causing layout shifts' })
      .option('hreflang', { type: 'boolean', describe: 'Validate hreflang link tags' })
      .option('cookie-flags', { type: 'boolean', describe: 'Audit cookie Secure/HttpOnly/SameSite flags' })
      .option('focus-trap', { type: 'boolean', describe: 'Detect focus traps in modals/dialogs' })
      .option('favicon', { type: 'boolean', describe: 'Validate favicon and apple-touch-icon presence' })
      .option('clickjacking', { type: 'boolean', describe: 'Probe clickjacking defences (X-Frame-Options / CSP)' })
      .option('critical-css', { type: 'boolean', describe: 'Extract above-the-fold critical CSS' })
      .option('sourcemap-scan', { type: 'boolean', describe: 'Scan for exposed JS source maps' })
      .option('secret-scan', { type: 'boolean', describe: 'Scan HTML/JS for leaked API keys and secrets' })
      .option('tracker-sniff', { type: 'boolean', describe: 'Detect analytics / ad / tracker network calls' })
      .option('z-index', { type: 'boolean', describe: 'Audit z-index usage and stacking context issues' })
      .option('hydration', { type: 'boolean', describe: 'SSR hydration mismatch detection (React/Vue/Svelte)' })
      .option('storage', { type: 'boolean', describe: 'Audit localStorage/sessionStorage/IndexedDB usage' })
      .option('csrf', { type: 'boolean', describe: 'CSRF defence audit (tokens + SameSite cookies)' })
      .option('error-pages', { type: 'boolean', describe: 'Detect broken/misconfigured 404 and 500 pages' })
      .option('stuck-spinners', { type: 'boolean', describe: 'Detect loading spinners / aria-busy that persist past timeout' })
      .option('error-state', { type: 'boolean', describe: 'Flag clicks that reveal new error-state DOM elements (alerts, toasts)' })
      .option('frustration', { type: 'boolean', describe: 'Detect frustration signals (rage/dead/u-turn/error-click, thrashed cursor) during synthetic runs' })
      .option('out', { type: 'string', default: './uxinspect-report', describe: 'Output directory' })
      .option('baselines', { type: 'string', default: './uxinspect-baselines', describe: 'Visual baseline directory' })
      .option('ai', { type: 'boolean', default: false, describe: 'Enable keyless AI flow steps' })
      .option('headed', { type: 'boolean', default: false, describe: 'Run with visible browser window' })
      .option('debug', { type: 'boolean', default: false, describe: 'Headed + slowMo (step-by-step)' })
      .option('slow-mo', { type: 'number', describe: 'Slow each action by N ms' })
      .option('parallel', { type: 'boolean', default: false, describe: 'Run flows in parallel' })
      .option('browser', { type: 'string', choices: ['chromium', 'firefox', 'webkit'], default: 'chromium' })
      .option('device', { type: 'string', describe: 'Device preset name (e.g. "iPhone 13", "Pixel 5")' })
      .option('locale', { type: 'string', describe: 'Locale override (e.g. en-US, ja-JP)' })
      .option('timezone', { type: 'string', describe: 'Timezone override (e.g. America/New_York)' })
      .option('network', { type: 'string', choices: ['slow-3g', 'fast-3g', '4g', 'wifi'], describe: 'Throttle network' })
      .option('video', { type: 'boolean', default: false, describe: 'Record video of flows' })
      .option('har', { type: 'boolean', default: false, describe: 'Export HAR file' })
      .option('trace', { type: 'boolean', default: false, describe: 'Export Playwright trace' })
      .option('storage-state', { type: 'string', describe: 'Path to playwright storageState JSON for auth' })
      .option('gated-routes', { type: 'string', describe: 'Path to file with one URL per line, sitemap.xml URL, or glob pattern. Combined with --storage-state triggers auth-gated route walker.' })
      .option('gated-concurrency', { type: 'number', describe: 'Concurrency for auth-gated route walker (default 4)' })
      .option('reporters', { type: 'string', default: 'html,json', describe: 'Comma list: html,json,junit,sarif' })
      .option('publish', { type: 'string', describe: 'Dashboard URL to upload report' })
      .option('publish-token', { type: 'string', describe: 'Bearer token for dashboard upload' })
      .option('budget', { type: 'string', describe: 'Path to budget JSON (perf/metrics/a11y/visual thresholds)' })
      .option('coverage-min', { type: 'number', describe: 'Minimum click coverage % (explore). Build fails if actual < threshold.' })
      .option('slack', { type: 'string', describe: 'Slack webhook URL for notifications' })
      .option('discord', { type: 'string', describe: 'Discord webhook URL for notifications' })
      .option('webhook', { type: 'string', describe: 'Generic JSON webhook URL' })
      .option('notify-on-fail', { type: 'boolean', default: true, describe: 'Only notify on failure' }),
  )
  .command('report <dir>', 'Serve a generated report on localhost', (y) =>
    y
      .positional('dir', { type: 'string', demandOption: true, describe: 'Report directory' })
      .option('port', { type: 'number', default: 4173, describe: 'Port to serve on' }),
  )
  .command('init [dir]', 'Create a starter uxinspect.config.ts', (y) =>
    y.positional('dir', { type: 'string', default: '.', describe: 'Directory to initialize' }),
  )
  .command('record', 'Record a flow by clicking in a real browser', (y) =>
    y
      .option('url', { type: 'string', demandOption: true })
      .option('save', { type: 'string', describe: 'Parse codegen output and save to this config path' })
      .option('name', { type: 'string', default: 'recorded', describe: 'Flow name when saving' }),
  )
  .command('accept <dir>', 'Accept current screenshots as new visual baselines', (y) =>
    y
      .positional('dir', { type: 'string', demandOption: true, describe: 'Report directory (with current/ subdir)' })
      .option('baselines', { type: 'string', default: './uxinspect-baselines' }),
  )
  .command('watch', 'Re-run inspection on file changes', (y) =>
    y
      .option('config', { type: 'string', demandOption: true })
      .option('path', { type: 'string', default: '.', describe: 'Directory to watch' }),
  )
  .command('replay <path>', 'Open a self-contained rrweb replay viewer for a recorded JSON', (y) =>
    y
      .positional('path', { type: 'string', demandOption: true, describe: 'Path to replay JSON (rrweb events array)' })
      .option('out', { type: 'string', describe: 'Write the generated HTML to this path instead of a temp file' })
      .option('open', { type: 'boolean', default: true, describe: 'Open the generated viewer in the default browser' })
      .option('width', { type: 'number', describe: 'Player width in pixels (default 1024)' })
      .option('height', { type: 'number', describe: 'Player height in pixels (default 576)' })
      .option('no-autoplay', { type: 'boolean', describe: 'Do not auto-play the replay on load' })
      .option('title', { type: 'string', describe: 'Custom title for the viewer page' }),
  )
  .command('diff <baseline> [current]', 'Diff two inspect JSON results (auto-uses .uxinspect/last.json when [current] omitted)', (y) =>
    y
      .positional('baseline', { type: 'string', demandOption: true, describe: 'Path to the baseline inspect result JSON' })
      .positional('current', { type: 'string', describe: 'Path to the current inspect result JSON (defaults to .uxinspect/last.json)' })
      .option('json', { type: 'boolean', default: false, describe: 'Emit machine-readable JSON instead of pretty output' })
      .option('color', { type: 'boolean', describe: 'Force color output (default: auto-detect TTY)' })
      .option('no-color', { type: 'boolean', describe: 'Disable color output' }),
  )
  .demandCommand(1)
  .strict()
  .help()
  .parse();

const cmd = (argv as any)._[0];

if (cmd === 'run') await runCmd();
if (cmd === 'report') await reportCmd();
if (cmd === 'init') await initCmd();
if (cmd === 'record') await recordCmd();
if (cmd === 'accept') await acceptCmd();
if (cmd === 'watch') await watchCmd();
if (cmd === 'replay') await replayCmd();
if (cmd === 'diff') await diffCmd();

async function runCmd(): Promise<void> {
  const reporters = String((argv as any).reporters)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as ('html' | 'json' | 'junit' | 'sarif')[];

  const budget = (argv as any).budget
    ? JSON.parse(await fs.readFile(path.resolve((argv as any).budget), 'utf8'))
    : undefined;

  const a = argv as any;
  const all: boolean | undefined = a.all === true ? true : undefined;
  const pick = (v: unknown): boolean | undefined =>
    v === undefined ? all : Boolean(v);
  const checks = {
    a11y: pick(a.a11y),
    perf: pick(a.perf),
    visual: pick(a.visual),
    explore: pick(a.explore),
    seo: pick(a.seo),
    links: pick(a.links),
    pwa: pick(a.pwa),
    security: pick(a.security),
    retire: pick(a.retire),
    deadClicks: pick(a['dead-clicks']),
    disabledButtons: pick(a['disabled-buttons']),
    touchTargets: pick(a['touch-targets']),
    keyboard: pick(a.keyboard),
    longTasks: pick(a['long-tasks']),
    clsTimeline: pick(a['cls-timeline']),
    forms: pick(a.forms),
    formBehavior: pick(a['form-behavior']),
    structuredData: pick(a['structured-data']),
    passiveSecurity: pick(a['passive-security']),
    consoleErrors: pick(a['console-errors']),
    sitemap: pick(a.sitemap),
    redirects: pick(a.redirects),
    exposedPaths: pick(a['exposed-paths']),
    tls: pick(a.tls),
    crawl: pick(a.crawl),
    contentQuality: pick(a['content-quality']),
    resourceHints: pick(a['resource-hints']),
    mixedContent: pick(a['mixed-content']),
    compression: pick(a.compression),
    cacheHeaders: pick(a['cache-headers']),
    cookieBanner: pick(a['cookie-banner']),
    thirdParty: pick(a['third-party']),
    bundleSize: pick(a['bundle-size']),
    openGraph: pick(a['open-graph']),
    robotsAudit: pick(a['robots-audit']),
    imageAudit: pick(a['image-audit']),
    webfonts: pick(a.webfonts),
    motionPrefs: pick(a['motion-prefs']),
    sri: pick(a.sri),
    webWorkers: pick(a['web-workers']),
    orphanAssets: pick(a['orphan-assets']),
    inp: pick(a.inp),
    lcpElement: pick(a['lcp-element']),
    clsCulprit: pick(a['cls-culprit']),
    hreflang: pick(a.hreflang),
    cookieFlags: pick(a['cookie-flags']),
    focusTrap: pick(a['focus-trap']),
    favicon: pick(a.favicon),
    clickjacking: pick(a.clickjacking),
    criticalCss: pick(a['critical-css']),
    sourcemapScan: pick(a['sourcemap-scan']),
    secretScan: pick(a['secret-scan']),
    trackerSniff: pick(a['tracker-sniff']),
    zIndex: pick(a['z-index']),
    hydration: pick(a.hydration),
    storage: pick(a.storage),
    csrf: pick(a.csrf),
    errorPages: pick(a['error-pages']),
    stuckSpinners: pick(a['stuck-spinners']),
    errorState: pick(a['error-state']),
    frustrationSignals: pick(a.frustration),
  };
  const cliConfig: InspectConfig = {
    url: a.url,
    checks: checks as InspectConfig['checks'],
    output: { dir: (argv as any).out, baselineDir: (argv as any).baselines },
    ai: (argv as any).ai ? { enabled: true } : undefined,
    headed: (argv as any).headed,
    debug: (argv as any).debug,
    slowMo: (argv as any)['slow-mo'],
    parallel: (argv as any).parallel,
    browser: (argv as any).browser,
    device: (argv as any).device,
    locale: (argv as any).locale,
    timezoneId: (argv as any).timezone,
    network: (argv as any).network,
    video: (argv as any).video,
    har: (argv as any).har,
    trace: (argv as any).trace,
    storageState: (argv as any)['storage-state'],
    gatedRoutes: (argv as any)['gated-routes'],
    gatedRoutesOptions:
      (argv as any)['gated-concurrency'] !== undefined
        ? { concurrency: (argv as any)['gated-concurrency'] }
        : undefined,
    reporters,
    budget,
    notify: notifyCfg(),
  };

  const config: InspectConfig = (argv as any).config
    ? { ...(await loadConfig((argv as any).config)), ...cliConfig }
    : cliConfig;

  console.log(`Inspecting ${config.url}...`);
  const result = await inspect(config);
  const status = result.passed ? 'PASS' : 'FAIL';
  console.log(`\n${status} — ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`Report: ${path.resolve(config.output?.dir ?? './uxinspect-report', 'report.html')}`);

  // Auto-save last run for `uxinspect diff` (P2 #19).
  try {
    await saveLastRun(result);
  } catch (e) {
    console.error(`warn: could not write ${LAST_RUN_FILE}: ${(e as Error).message}`);
  }

  if (result.budget && result.budget.length) {
    console.log('\nBudget violations:');
    for (const v of result.budget) console.log(`  - ${v.message}`);
  }

  const publishUrl = (argv as any).publish as string | undefined;
  if (publishUrl) {
    const token = ((argv as any)['publish-token'] as string | undefined) ?? process.env.UXINSPECT_PUBLISH_TOKEN;
    try {
      const res = await fetch(`${publishUrl.replace(/\/$/, '')}/upload`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(result),
      });
      if (res.ok) {
        const { url: reportUrl } = (await res.json()) as { url: string };
        console.log(`Published: ${publishUrl.replace(/\/$/, '')}${reportUrl}`);
      } else {
        console.error(`Publish failed: ${res.status} ${res.statusText}`);
      }
    } catch (e) {
      console.error(`Publish error: ${(e as Error).message}`);
    }
  }

  const coverageMin = (argv as any)['coverage-min'] as number | undefined;
  let coverageFailed = false;
  if (typeof coverageMin === 'number' && result.explore?.coverage) {
    const pct = result.explore.coverage.percent;
    if (pct < coverageMin) {
      console.log(`\nCoverage ${pct}% < required ${coverageMin}% (clicked ${result.explore.coverage.clicked}/${result.explore.coverage.total})`);
      coverageFailed = true;
    } else {
      console.log(`\nCoverage ${pct}% >= required ${coverageMin}%`);
    }
  }

  process.exit(result.passed && !coverageFailed ? 0 : 1);
}

function notifyCfg() {
  const a = argv as any;
  if (!a.slack && !a.discord && !a.webhook) return undefined;
  return {
    slackWebhook: a.slack,
    discordWebhook: a.discord,
    genericWebhook: a.webhook,
    onlyOnFail: a['notify-on-fail'] ?? true,
  };
}

async function reportCmd(): Promise<void> {
  const dir = path.resolve((argv as any).dir);
  const port = (argv as any).port as number;
  const stat = await fs.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) {
    console.error(`Not a directory: ${dir}`);
    process.exit(1);
  }
  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0]!;
    const file = url === '/' ? 'report.html' : url.replace(/^\//, '');
    const full = path.join(dir, file);
    if (!full.startsWith(dir)) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }
    try {
      const data = await fs.readFile(full);
      res.setHeader('content-type', mime(full));
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  server.listen(port, () => {
    console.log(`uxinspect report viewer: http://localhost:${port}`);
  });
}

async function initCmd(): Promise<void> {
  const dir = path.resolve((argv as any).dir as string);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, 'uxinspect.config.ts');
  if (await fs.stat(target).catch(() => null)) {
    console.error(`${target} already exists`);
    process.exit(1);
  }
  await fs.writeFile(target, STARTER_CONFIG);
  const budgetPath = path.join(dir, 'uxinspect.budget.json');
  if (!(await fs.stat(budgetPath).catch(() => null))) {
    await fs.writeFile(budgetPath, STARTER_BUDGET);
  }
  const ghDir = path.join(dir, '.github', 'workflows');
  await fs.mkdir(ghDir, { recursive: true });
  const ghTarget = path.join(ghDir, 'uxinspect.yml');
  if (!(await fs.stat(ghTarget).catch(() => null))) {
    await fs.writeFile(ghTarget, GITHUB_ACTION);
  }
  console.log('Created:');
  console.log(`  ${target}`);
  console.log(`  ${budgetPath}`);
  console.log(`  ${ghTarget}`);
  console.log('\nRun:  uxinspect run --config ./uxinspect.config.ts');
}

async function recordCmd(): Promise<void> {
  const url = (argv as any).url as string;
  const savePath = (argv as any).save as string | undefined;
  const name = (argv as any).name as string;

  if (!savePath) {
    console.log(`Opening ${url} for recording. Click through your flow, then close the browser.`);
    const child = spawn('npx', ['playwright', 'codegen', url], { stdio: 'inherit' });
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    console.log('\nPaste the recorded steps into your uxinspect.config.ts flows array.');
    return;
  }

  const tmp = path.join(process.cwd(), `.uxinspect-recorded-${Date.now()}.ts`);
  console.log(`Opening ${url} for recording. Close the browser to finish — codegen writes to ${tmp}`);
  const child = spawn('npx', ['playwright', 'codegen', '--output', tmp, url], { stdio: 'inherit' });
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));

  const code = await fs.readFile(tmp, 'utf8').catch(() => '');
  await fs.unlink(tmp).catch(() => {});
  if (!code) {
    console.error('No recording captured.');
    process.exit(1);
  }

  const steps = parseCodegen(code);
  if (!steps.length) {
    console.error('Could not parse any steps from codegen output.');
    process.exit(1);
  }

  await appendFlowToConfig(path.resolve(savePath), name, steps);
  console.log(`\nAppended flow "${name}" (${steps.length} steps) to ${savePath}`);
}

function parseCodegen(code: string): any[] {
  const steps: any[] = [];
  const lines = code.split('\n').map((l) => l.trim());
  for (const line of lines) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/page\.goto\(['"]([^'"]+)['"]\)/))) {
      steps.push({ goto: m[1] });
    } else if ((m = line.match(/getByRole\(['"](\w+)['"](?:,\s*\{\s*name:\s*['"]([^'"]+)['"]\s*\})?\)\.click\(\)/))) {
      steps.push({ click: m[2] ? `role=${m[1]}[name="${m[2]}"]` : `role=${m[1]}` });
    } else if ((m = line.match(/getByRole\(['"](\w+)['"](?:,\s*\{\s*name:\s*['"]([^'"]+)['"]\s*\})?\)\.fill\(['"]([^'"]+)['"]\)/))) {
      steps.push({ fill: { selector: m[2] ? `role=${m[1]}[name="${m[2]}"]` : `role=${m[1]}`, text: m[3] } });
    } else if ((m = line.match(/getByLabel\(['"]([^'"]+)['"]\)\.fill\(['"]([^'"]+)['"]\)/))) {
      steps.push({ fill: { selector: `label=${m[1]}`, text: m[2] } });
    } else if ((m = line.match(/getByPlaceholder\(['"]([^'"]+)['"]\)\.fill\(['"]([^'"]+)['"]\)/))) {
      steps.push({ fill: { selector: `placeholder=${m[1]}`, text: m[2] } });
    } else if ((m = line.match(/locator\(['"]([^'"]+)['"]\)\.click\(\)/))) {
      steps.push({ click: m[1] });
    } else if ((m = line.match(/locator\(['"]([^'"]+)['"]\)\.fill\(['"]([^'"]+)['"]\)/))) {
      steps.push({ fill: { selector: m[1], text: m[2] } });
    } else if ((m = line.match(/keyboard\.press\(['"]([^'"]+)['"]\)/))) {
      steps.push({ key: m[1] });
    }
  }
  return steps;
}

async function appendFlowToConfig(configPath: string, name: string, steps: any[]): Promise<void> {
  const exists = await fs.stat(configPath).catch(() => null);
  const body = JSON.stringify({ name, steps }, null, 2);
  if (!exists) {
    const template = `import type { InspectConfig } from 'uxinspect';\n\nexport default {\n  url: 'https://example.com',\n  flows: [\n${body}\n  ],\n} satisfies InspectConfig;\n`;
    await fs.writeFile(configPath, template);
    return;
  }
  const cur = await fs.readFile(configPath, 'utf8');
  const flowsMatch = cur.match(/flows:\s*\[([\s\S]*?)\]/);
  if (!flowsMatch) {
    await fs.writeFile(configPath + `.recorded-${Date.now()}.json`, body);
    console.log('Could not edit flows array in place; wrote adjacent JSON instead.');
    return;
  }
  const before = cur.slice(0, flowsMatch.index! + flowsMatch[0].indexOf('[') + 1);
  const after = cur.slice(flowsMatch.index! + flowsMatch[0].length - 1);
  const injected = `\n${body},${flowsMatch[1]!.trim() ? '\n' + flowsMatch[1] : ''}`;
  await fs.writeFile(configPath, before + injected + after);
}

async function watchCmd(): Promise<void> {
  const configPath = (argv as any).config as string;
  const watchPath = path.resolve((argv as any).path as string);
  let running = false;
  let queued = false;

  const run = async () => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      const config = await loadConfig(configPath);
      console.log(`[${new Date().toLocaleTimeString()}] running…`);
      const result = await inspect(config);
      const status = result.passed ? 'PASS' : 'FAIL';
      console.log(`[${new Date().toLocaleTimeString()}] ${status} — ${(result.durationMs / 1000).toFixed(1)}s`);
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
    }
    running = false;
    if (queued) {
      queued = false;
      run();
    }
  };

  console.log(`Watching ${watchPath}. Editing any file triggers a re-run.`);
  await run();
  const { watch } = await import('node:fs');
  let debounce: NodeJS.Timeout | null = null;
  watch(watchPath, { recursive: true }, (_ev, file) => {
    if (!file) return;
    const s = String(file);
    if (s.includes('node_modules') || s.includes('uxinspect-report') || s.includes('uxinspect-baselines') || s.startsWith('.')) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => run(), 300);
  });
}

async function acceptCmd(): Promise<void> {
  const dir = path.resolve((argv as any).dir as string);
  const baselines = path.resolve((argv as any).baselines as string);
  const currentDir = path.join(dir, 'current');
  await fs.mkdir(baselines, { recursive: true });
  const files = await fs.readdir(currentDir).catch(() => []);
  let count = 0;
  for (const f of files) {
    if (!f.endsWith('.png')) continue;
    await fs.copyFile(path.join(currentDir, f), path.join(baselines, f));
    count++;
  }
  console.log(`Accepted ${count} baseline(s) into ${baselines}`);
}

async function replayCmd(): Promise<void> {
  const a = argv as any;
  const inputPath = path.resolve(a.path as string);

  const stat = await fs.stat(inputPath).catch(() => null);
  if (!stat?.isFile()) {
    console.error(`Replay JSON not found: ${inputPath}`);
    process.exit(1);
  }

  const outPath = a.out
    ? path.resolve(a.out as string)
    : path.join(os.tmpdir(), `uxinspect-replay-${Date.now()}-${path.basename(inputPath, '.json')}.html`);

  let htmlPath: string;
  try {
    htmlPath = await writeReplayViewer(inputPath, outPath, {
      width: typeof a.width === 'number' ? a.width : undefined,
      height: typeof a.height === 'number' ? a.height : undefined,
      autoPlay: a['no-autoplay'] ? false : undefined,
      title: typeof a.title === 'string' ? a.title : undefined,
    });
  } catch (e) {
    console.error(`Replay viewer failed: ${(e as Error).message}`);
    process.exit(1);
  }

  console.log(`Replay viewer: ${htmlPath}`);

  if (a.open === false) return;

  const opener = process.platform === 'darwin'
    ? { cmd: 'open', args: [htmlPath] }
    : process.platform === 'win32'
      ? { cmd: 'cmd', args: ['/c', 'start', '""', htmlPath] }
      : { cmd: 'xdg-open', args: [htmlPath] };

  const child = spawn(opener.cmd, opener.args, { stdio: 'ignore', detached: true });
  child.on('error', (err) => {
    console.error(`Could not launch browser (${opener.cmd}): ${err.message}`);
    console.error(`Open the file manually: ${htmlPath}`);
  });
  child.unref();
}

async function diffCmd(): Promise<void> {
  const a = argv as any;
  const baselinePath = path.resolve(String(a.baseline));
  const currentArg = a.current as string | undefined;
  const currentPath = currentArg
    ? path.resolve(String(currentArg))
    : path.resolve(process.cwd(), LAST_RUN_FILE);

  const baselineStat = await fs.stat(baselinePath).catch(() => null);
  if (!baselineStat?.isFile()) {
    console.error(`Baseline not found: ${baselinePath}`);
    process.exit(1);
  }
  const currentStat = await fs.stat(currentPath).catch(() => null);
  if (!currentStat?.isFile()) {
    console.error(
      currentArg
        ? `Current not found: ${currentPath}`
        : `No current run to diff against. Run \`uxinspect run …\` first (auto-saves to ${LAST_RUN_FILE}) or pass a second JSON path.`,
    );
    process.exit(1);
  }

  let baseline, current;
  try {
    baseline = await loadResult(baselinePath);
    current = await loadResult(currentPath);
  } catch (e) {
    console.error(`Failed to parse JSON: ${(e as Error).message}`);
    process.exit(1);
  }

  const summary = diffResults(baseline, current);

  if (a.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const forceColor = a.color === true;
    const disableColor = a['no-color'] === true || a.color === false;
    const color = forceColor || (!disableColor && Boolean(process.stdout.isTTY));
    console.log(formatDiff(summary, { color }));
  }

  process.exit(summary.totalRegressions > 0 ? 1 : 0);
}

async function loadConfig(p: string): Promise<InspectConfig> {
  const abs = path.resolve(p);
  if (p.endsWith('.json')) {
    return JSON.parse(await fs.readFile(abs, 'utf8'));
  }
  const mod = await import(pathToFileURL(abs).href);
  return mod.default ?? mod.config;
}

function mime(p: string): string {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.json')) return 'application/json';
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.xml')) return 'application/xml';
  if (p.endsWith('.css')) return 'text/css';
  if (p.endsWith('.js')) return 'application/javascript';
  if (p.endsWith('.webm')) return 'video/webm';
  if (p.endsWith('.zip')) return 'application/zip';
  return 'application/octet-stream';
}

