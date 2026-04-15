import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cpus } from 'node:os';
import {
  FAST_MODE_SKIPPED_AUDITS,
  FAST_MODE_FLOW_TIMEOUT_MS,
  isFastMode,
  fastConcurrency,
  applyFastMode,
  fastModeBanner,
} from './index.js';
import { generateConfigSchema } from './json-schema.js';
import type { InspectConfig } from './types.js';

describe('fast mode — skip contract', () => {
  test('FAST_MODE_SKIPPED_AUDITS lists perf, visual, links, crossBrowser', () => {
    assert.deepEqual([...FAST_MODE_SKIPPED_AUDITS], ['perf', 'visual', 'links', 'crossBrowser']);
  });

  test('banner mentions every skipped audit', () => {
    const banner = fastModeBanner();
    for (const audit of FAST_MODE_SKIPPED_AUDITS) {
      assert.ok(banner.includes(audit), `banner should mention ${audit}: "${banner}"`);
    }
    assert.ok(banner.toLowerCase().includes('fast mode'), `banner should tag fast mode: "${banner}"`);
  });
});

describe('isFastMode', () => {
  test('returns true only when fast === true', () => {
    assert.equal(isFastMode({ fast: true }), true);
    assert.equal(isFastMode({ fast: false }), false);
    assert.equal(isFastMode({}), false);
  });
});

describe('fastConcurrency', () => {
  test('respects explicit requested value when > 0', () => {
    assert.equal(fastConcurrency(3), 3);
    assert.equal(fastConcurrency(12), 12);
  });

  test('defaults to max(8, cpus())', () => {
    const expected = Math.max(8, cpus().length || 1);
    assert.equal(fastConcurrency(), expected);
    assert.equal(fastConcurrency(undefined), expected);
    // 0 is treated as "not provided"
    assert.equal(fastConcurrency(0), expected);
    assert.ok(expected >= 8, 'concurrency floor must be 8');
  });
});

describe('applyFastMode', () => {
  const baseCfg: InspectConfig = { url: 'https://example.com' };

  test('skips perf / visual / links', () => {
    const o = applyFastMode(baseCfg);
    assert.equal(o.checks.perf, false);
    assert.equal(o.checks.visual, false);
    assert.equal(o.checks.links, false);
  });

  test('always enables a11y, consoleErrors, forms', () => {
    const o = applyFastMode(baseCfg);
    assert.equal(o.checks.a11y, true);
    assert.equal(o.checks.consoleErrors, true);
    assert.equal(o.checks.forms, true);
  });

  test('overrides user-provided perf/visual/links even if explicitly true', () => {
    const o = applyFastMode({
      ...baseCfg,
      checks: { perf: true, visual: true, links: true },
    });
    assert.equal(o.checks.perf, false);
    assert.equal(o.checks.visual, false);
    assert.equal(o.checks.links, false);
  });

  test('forces parallel = true with concurrency = max(8, cpus())', () => {
    const o = applyFastMode(baseCfg);
    assert.equal(o.parallel, true);
    assert.equal(o.concurrency, Math.max(8, cpus().length || 1));
  });

  test('respects caller-supplied concurrency', () => {
    const o = applyFastMode({ ...baseCfg, concurrency: 5 });
    assert.equal(o.concurrency, 5);
  });

  test('sets flowTimeoutMs to 20_000 by default', () => {
    const o = applyFastMode(baseCfg);
    assert.equal(o.flowTimeoutMs, FAST_MODE_FLOW_TIMEOUT_MS);
    assert.equal(o.flowTimeoutMs, 20_000);
  });

  test('respects caller-supplied flowTimeoutMs', () => {
    const o = applyFastMode({ ...baseCfg, flowTimeoutMs: 5_000 });
    assert.equal(o.flowTimeoutMs, 5_000);
  });

  test('does not mutate the input config', () => {
    const cfg: InspectConfig = { ...baseCfg, checks: { perf: true, a11y: false } };
    const snapshot = JSON.stringify(cfg);
    applyFastMode(cfg);
    assert.equal(JSON.stringify(cfg), snapshot);
  });

  test('skipped list is exposed on the result', () => {
    const o = applyFastMode(baseCfg);
    assert.deepEqual([...o.skipped], ['perf', 'visual', 'links', 'crossBrowser']);
  });

  test('preserves other check toggles the user set', () => {
    const o = applyFastMode({
      ...baseCfg,
      checks: { seo: true, security: true, retire: false },
    });
    assert.equal(o.checks.seo, true);
    assert.equal(o.checks.security, true);
    assert.equal(o.checks.retire, false);
  });
});

describe('json-schema exposes fast-mode knobs', () => {
  test('top-level schema has fast, concurrency, flowTimeoutMs', () => {
    const schema = generateConfigSchema();
    const props = schema.properties ?? {};
    assert.equal(props.fast?.type, 'boolean', 'fast should be boolean');
    assert.equal(props.concurrency?.type, 'number', 'concurrency should be number');
    assert.equal(props.flowTimeoutMs?.type, 'number', 'flowTimeoutMs should be number');
  });

  test('schema still marks only url as required', () => {
    const schema = generateConfigSchema();
    assert.deepEqual(schema.required, ['url']);
  });
});

describe('watch defaults to fast mode', () => {
  // Contract check: the CLI watch handler must default --fast to true.
  // We verify by importing the compiled cli.js source and grepping for the
  // default-true option definition, since spawning the CLI in a test
  // environment without a Playwright target would be flaky.
  test('cli.ts watch command declares --fast default true', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const watchBlock = src.match(/\.command\('watch'[\s\S]*?\),\s*\)/);
    assert.ok(watchBlock, 'watch command block not found in cli.ts');
    assert.match(
      watchBlock![0],
      /option\('fast',\s*\{[^}]*default:\s*true/,
      'watch command must declare --fast with default: true',
    );
  });

  test('watchCmd handler treats fast as default-true', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');
    assert.match(
      src,
      /async function watchCmd[\s\S]*?fast\s*=\s*\(argv as any\)\.fast\s*!==\s*false/,
      'watchCmd must set fast = (argv).fast !== false',
    );
    assert.match(
      src,
      /async function watchCmd[\s\S]*?fast:\s*fast\s*\|\|\s*loaded\.fast\s*===\s*true/,
      'watchCmd must pass fast into the InspectConfig',
    );
  });
});
