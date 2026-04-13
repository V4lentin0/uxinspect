#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { inspect } from './index.js';
import type { InspectConfig } from './types.js';

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
      .option('out', { type: 'string', default: './uxinspect-report', describe: 'Output directory' })
      .option('baselines', { type: 'string', default: './uxinspect-baselines', describe: 'Visual baseline directory' })
      .option('ai', { type: 'boolean', default: false, describe: 'Enable keyless AI flow steps' })
      .option('headed', { type: 'boolean', default: false, describe: 'Run with visible browser window' })
      .option('parallel', { type: 'boolean', default: false, describe: 'Run flows in parallel' })
      .option('storage-state', { type: 'string', describe: 'Path to playwright storageState JSON for auth' })
      .option('reporters', {
        type: 'string',
        default: 'html,json',
        describe: 'Comma list: html,json,junit,sarif',
      }),
  )
  .command('report <dir>', 'Serve a generated report on localhost', (y) =>
    y
      .positional('dir', { type: 'string', demandOption: true, describe: 'Report directory' })
      .option('port', { type: 'number', default: 4173, describe: 'Port to serve on' }),
  )
  .demandCommand(1)
  .strict()
  .help()
  .parse();

const cmd = (argv as any)._[0];

if (cmd === 'run') {
  const reporters = String((argv as any).reporters)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as ('html' | 'json' | 'junit' | 'sarif')[];

  const config: InspectConfig = (argv as any).config
    ? await loadConfig((argv as any).config)
    : {
        url: (argv as any).url,
        checks: {
          a11y: (argv as any).a11y,
          perf: (argv as any).perf,
          visual: (argv as any).visual,
          explore: (argv as any).explore,
        },
        output: { dir: (argv as any).out, baselineDir: (argv as any).baselines },
        ai: (argv as any).ai ? { enabled: true } : undefined,
        headed: (argv as any).headed,
        parallel: (argv as any).parallel,
        storageState: (argv as any)['storage-state'],
        reporters,
      };

  console.log(`Inspecting ${config.url}...`);
  const result = await inspect(config);
  const status = result.passed ? 'PASS' : 'FAIL';
  console.log(`\n${status} — ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`Report: ${path.resolve(config.output?.dir ?? './uxinspect-report', 'report.html')}`);
  process.exit(result.passed ? 0 : 1);
}

if (cmd === 'report') {
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
  return 'application/octet-stream';
}
