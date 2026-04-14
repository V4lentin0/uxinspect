#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { inspect } from './index.js';
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
      .option('a11y', { type: 'boolean', default: true, describe: 'Run accessibility checks' })
      .option('perf', { type: 'boolean', default: false, describe: 'Run performance audit' })
      .option('visual', { type: 'boolean', default: true, describe: 'Run visual diff' })
      .option('explore', { type: 'boolean', default: false, describe: 'Auto-explore by clicking everything' })
      .option('seo', { type: 'boolean', default: false, describe: 'SEO audit (meta, OG, canonical)' })
      .option('links', { type: 'boolean', default: false, describe: 'Broken link crawler' })
      .option('pwa', { type: 'boolean', default: false, describe: 'PWA audit (manifest, service worker)' })
      .option('security', { type: 'boolean', default: false, describe: 'Security headers audit' })
      .option('out', { type: 'string', default: './uxinspect-report', describe: 'Output directory' })
      .option('baselines', { type: 'string', default: './uxinspect-baselines', describe: 'Visual baseline directory' })
      .option('ai', { type: 'boolean', default: false, describe: 'Enable keyless AI flow steps' })
      .option('headed', { type: 'boolean', default: false, describe: 'Run with visible browser window' })
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
      .option('reporters', { type: 'string', default: 'html,json', describe: 'Comma list: html,json,junit,sarif' })
      .option('publish', { type: 'string', describe: 'Dashboard URL to upload report' })
      .option('publish-token', { type: 'string', describe: 'Bearer token for dashboard upload' })
      .option('budget', { type: 'string', describe: 'Path to budget JSON (perf/metrics/a11y/visual thresholds)' })
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
    y.option('url', { type: 'string', demandOption: true }),
  )
  .command('accept <dir>', 'Accept current screenshots as new visual baselines', (y) =>
    y
      .positional('dir', { type: 'string', demandOption: true, describe: 'Report directory (with current/ subdir)' })
      .option('baselines', { type: 'string', default: './uxinspect-baselines' }),
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

async function runCmd(): Promise<void> {
  const reporters = String((argv as any).reporters)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as ('html' | 'json' | 'junit' | 'sarif')[];

  const budget = (argv as any).budget
    ? JSON.parse(await fs.readFile(path.resolve((argv as any).budget), 'utf8'))
    : undefined;

  const cliConfig: InspectConfig = {
    url: (argv as any).url,
    checks: {
      a11y: (argv as any).a11y,
      perf: (argv as any).perf,
      visual: (argv as any).visual,
      explore: (argv as any).explore,
      seo: (argv as any).seo,
      links: (argv as any).links,
      pwa: (argv as any).pwa,
      security: (argv as any).security,
    },
    output: { dir: (argv as any).out, baselineDir: (argv as any).baselines },
    ai: (argv as any).ai ? { enabled: true } : undefined,
    headed: (argv as any).headed,
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

  process.exit(result.passed ? 0 : 1);
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
  console.log(`Opening ${url} for recording. Click through your flow, then close the browser.`);
  const child = spawn('npx', ['playwright', 'codegen', url], { stdio: 'inherit' });
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  console.log('\nPaste the recorded steps into your uxinspect.config.ts flows array.');
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

