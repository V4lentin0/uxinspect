#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
      .option('ai', { type: 'boolean', default: false, describe: 'Enable keyless AI flow steps' }),
  )
  .demandCommand(1)
  .strict()
  .help()
  .parse();

const cmd = (argv as any)._[0];
if (cmd === 'run') {
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
      };

  console.log(`Inspecting ${config.url}...`);
  const result = await inspect(config);
  const status = result.passed ? 'PASS' : 'FAIL';
  console.log(`\n${status} — ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`Report: ${path.resolve(config.output?.dir ?? './uxinspect-report', 'report.html')}`);
  process.exit(result.passed ? 0 : 1);
}

async function loadConfig(p: string): Promise<InspectConfig> {
  const abs = path.resolve(p);
  if (p.endsWith('.json')) {
    return JSON.parse(await fs.readFile(abs, 'utf8'));
  }
  const mod = await import(pathToFileURL(abs).href);
  return mod.default ?? mod.config;
}
