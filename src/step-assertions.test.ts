/**
 * P0 #1 — Unit tests for the per-step assertion DSL.
 *
 * Covers the rich variants added to `AssertConfig`:
 * - console: 'clean' | { allow: string[] }
 * - network: 'no-4xx' | 'no-5xx' | 'no-errors' | { allow: number[] }
 * - dom: 'no-error' | { selector, mustExist/mustNotExist }
 * - visual: 'matches' | { name, threshold }
 * - timing: { maxMs }
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  attachStepAssertionTracker,
  evaluateStepAssertions,
  type StepAssertionTracker,
} from './index.js';
import type { AssertConfig } from './types.js';

let browser: Browser;
let context: BrowserContext;
let tmpDir: string;

before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 320, height: 240 } });
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-step-assert-'));
});

after(async () => {
  await context?.close();
  await browser?.close();
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function freshPage(html: string): Promise<Page> {
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  return page;
}

async function evalWith(
  page: Page,
  cfg: AssertConfig,
  fn: (tracker: StepAssertionTracker) => Promise<void>,
  opts: Partial<Parameters<typeof evaluateStepAssertions>[3]> = {},
) {
  const tracker = attachStepAssertionTracker(page, cfg);
  try {
    await fn(tracker);
    return await evaluateStepAssertions(page, cfg, tracker, {
      baselineDir: tmpDir,
      flowName: 'test-flow',
      stepIndex: 0,
      ...opts,
    });
  } finally {
    tracker.detach();
  }
}

// ─── console ────────────────────────────────────────────────────────

describe('console assertion', () => {
  test("'clean' passes with no console errors", async () => {
    const page = await freshPage('<html><body><button id="b">x</button></body></html>');
    const failures = await evalWith(page, { console: 'clean' }, async () => {
      await page.click('#b');
    });
    assert.equal(failures.length, 0);
    await page.close();
  });

  test("'clean' fails when an error fires", async () => {
    const page = await freshPage(
      '<html><body><button id="b" onclick="console.error(\'boom\')">x</button></body></html>',
    );
    const failures = await evalWith(page, { console: 'clean' }, async () => {
      await page.click('#b');
      await page.waitForTimeout(50);
    });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].kind, 'console');
    assert.match(failures[0].message, /1 new console error/);
    await page.close();
  });

  test('allow-list suppresses matching errors', async () => {
    const page = await freshPage(
      '<html><body><button id="b" onclick="console.error(\'ignore-me noise\')">x</button></body></html>',
    );
    const failures = await evalWith(page, { console: { allow: ['ignore-me'] } }, async () => {
      await page.click('#b');
      await page.waitForTimeout(50);
    });
    assert.equal(failures.length, 0);
    await page.close();
  });

  test('allow-list still fails on unrelated errors', async () => {
    const page = await freshPage(
      '<html><body><button id="b" onclick="console.error(\'real failure here\')">x</button></body></html>',
    );
    const failures = await evalWith(page, { console: { allow: ['ignore-me'] } }, async () => {
      await page.click('#b');
      await page.waitForTimeout(50);
    });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].kind, 'console');
    await page.close();
  });
});

// ─── network ────────────────────────────────────────────────────────

describe('network assertion', () => {
  test("'no-4xx' passes when only 5xx fires", async () => {
    const page = await freshPage('<html><body></body></html>');
    await page.route('**/status-500', (r) => r.fulfill({ status: 500, body: 'x' }));
    const failures = await evalWith(page, { network: 'no-4xx' }, async () => {
      await page.evaluate(() => fetch('https://example.com/status-500').catch(() => {}));
      await page.waitForTimeout(50);
    });
    assert.equal(failures.length, 0);
    await page.close();
  });

  test("'no-4xx' fails on a 404", async () => {
    const page = await freshPage('<html><body></body></html>');
    await page.route('**/missing', (r) => r.fulfill({ status: 404, body: 'x' }));
    const failures = await evalWith(page, { network: 'no-4xx' }, async () => {
      await page.evaluate(() => fetch('https://example.com/missing').catch(() => {}));
      await page.waitForTimeout(50);
    });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].kind, 'network');
    await page.close();
  });

  test("'no-5xx' ignores 4xx and flags 500", async () => {
    const page = await freshPage('<html><body></body></html>');
    await page.route('**/gone', (r) => r.fulfill({ status: 404, body: 'x' }));
    await page.route('**/crash', (r) => r.fulfill({ status: 500, body: 'x' }));
    const failures = await evalWith(page, { network: 'no-5xx' }, async () => {
      await page.evaluate(() => fetch('https://example.com/gone').catch(() => {}));
      await page.evaluate(() => fetch('https://example.com/crash').catch(() => {}));
      await page.waitForTimeout(50);
    });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].kind, 'network');
    assert.match(failures[0].message, /5xx/);
    await page.close();
  });

  test("'no-errors' flags both 4xx and 5xx", async () => {
    const page = await freshPage('<html><body></body></html>');
    await page.route('**/a', (r) => r.fulfill({ status: 404, body: 'x' }));
    await page.route('**/b', (r) => r.fulfill({ status: 500, body: 'x' }));
    const failures = await evalWith(page, { network: 'no-errors' }, async () => {
      await page.evaluate(() => fetch('https://example.com/a').catch(() => {}));
      await page.evaluate(() => fetch('https://example.com/b').catch(() => {}));
      await page.waitForTimeout(50);
    });
    assert.equal(failures.length, 1);
    assert.equal(
      (failures[0].details as { url: string; status: number }[]).length,
      2,
    );
    await page.close();
  });

  test('allow-list skips whitelisted status codes', async () => {
    const page = await freshPage('<html><body></body></html>');
    await page.route('**/ratelimited', (r) => r.fulfill({ status: 429, body: 'x' }));
    await page.route('**/crash', (r) => r.fulfill({ status: 500, body: 'x' }));
    const failures = await evalWith(page, { network: { allow: [429] } }, async () => {
      await page.evaluate(() => fetch('https://example.com/ratelimited').catch(() => {}));
      await page.evaluate(() => fetch('https://example.com/crash').catch(() => {}));
      await page.waitForTimeout(50);
    });
    assert.equal(failures.length, 1);
    const bad = failures[0].details as { status: number }[];
    assert.equal(bad.length, 1);
    assert.equal(bad[0].status, 500);
    await page.close();
  });
});

// ─── dom ────────────────────────────────────────────────────────────

describe('dom assertion', () => {
  test("'no-error' passes when no error elements appear", async () => {
    const page = await freshPage('<html><body><p>ok</p></body></html>');
    const failures = await evalWith(page, { dom: 'no-error' }, async () => {
      /* nothing */
    });
    assert.equal(failures.length, 0);
    await page.close();
  });

  test("'no-error' fails when a role=alert appears", async () => {
    const page = await freshPage(
      '<html><body><button id="b" onclick="document.body.innerHTML += \'<div role=alert>oops</div>\'">x</button></body></html>',
    );
    const failures = await evalWith(page, { dom: 'no-error' }, async () => {
      await page.click('#b');
      await page.waitForTimeout(30);
    });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].kind, 'dom');
    await page.close();
  });

  test('selector mustExist passes when present', async () => {
    const page = await freshPage('<html><body><div id="x">ok</div></body></html>');
    const failures = await evalWith(
      page,
      { dom: { selector: '#x', mustExist: true } },
      async () => {},
    );
    assert.equal(failures.length, 0);
    await page.close();
  });

  test('selector mustExist fails when absent', async () => {
    const page = await freshPage('<html><body></body></html>');
    const failures = await evalWith(
      page,
      { dom: { selector: '#missing', mustExist: true } },
      async () => {},
    );
    assert.equal(failures.length, 1);
    assert.equal(failures[0].kind, 'dom');
    assert.match(failures[0].message, /expected to exist/);
    await page.close();
  });

  test('selector mustNotExist fails when present', async () => {
    const page = await freshPage('<html><body><div class="err">oops</div></body></html>');
    const failures = await evalWith(
      page,
      { dom: { selector: '.err', mustNotExist: true } },
      async () => {},
    );
    assert.equal(failures.length, 1);
    assert.equal(failures[0].kind, 'dom');
    assert.match(failures[0].message, /expected absent/);
    await page.close();
  });
});

// ─── timing ─────────────────────────────────────────────────────────

describe('timing assertion', () => {
  test('passes when step fits in budget', async () => {
    const page = await freshPage('<html><body></body></html>');
    const failures = await evalWith(
      page,
      { timing: { maxMs: 5000 } },
      async () => {},
      { durationMs: 10 },
    );
    assert.equal(failures.length, 0);
    await page.close();
  });

  test('fails when step exceeds budget', async () => {
    const page = await freshPage('<html><body></body></html>');
    const failures = await evalWith(
      page,
      { timing: { maxMs: 50 } },
      async () => {},
      { durationMs: 500 },
    );
    assert.equal(failures.length, 1);
    assert.equal(failures[0].kind, 'timing');
    assert.match(failures[0].message, /500ms.*exceeds budget 50ms/);
    await page.close();
  });
});

// ─── visual (named baseline + threshold) ───────────────────────────

describe('visual assertion', () => {
  test('first run with named baseline saves baseline and passes', async () => {
    const page = await freshPage('<html><body style="background:#fff">hi</body></html>');
    const failures = await evalWith(
      page,
      { visual: { name: 'named-one', threshold: 0.5 } },
      async () => {},
      { flowName: 'visual-test' },
    );
    assert.equal(failures.length, 0);
    const baseline = path.join(tmpDir, 'steps', 'visual-test-named-one.png');
    const stat = await fs.stat(baseline);
    assert.ok(stat.isFile());
    await page.close();
  });

  test('custom threshold suppresses small drift', async () => {
    const page1 = await freshPage('<html><body style="background:#fff"><p>hello</p></body></html>');
    await evalWith(
      page1,
      { visual: { name: 'threshold-test', threshold: 0.9 } },
      async () => {},
      { flowName: 'visual-test' },
    );
    await page1.close();

    // Slightly different content but within generous threshold.
    const page2 = await freshPage('<html><body style="background:#fff"><p>hello!</p></body></html>');
    const failures = await evalWith(
      page2,
      { visual: { name: 'threshold-test', threshold: 0.9 } },
      async () => {},
      { flowName: 'visual-test' },
    );
    assert.equal(failures.length, 0);
    await page2.close();
  });
});
