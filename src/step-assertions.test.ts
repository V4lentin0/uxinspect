import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  attachStepAssertTracker,
  evaluateStepAssertions,
  type StepAssertTracker,
} from './index.js';
import type { Step, StepAssert } from './types.js';

let browser: Browser;
let context: BrowserContext;

before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
});

after(async () => {
  await context?.close();
  await browser?.close();
});

async function freshPage(html: string): Promise<Page> {
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  return page;
}

async function withTracker<T>(
  page: Page,
  fn: (tracker: StepAssertTracker) => Promise<T>,
): Promise<T> {
  const tracker = attachStepAssertTracker(page);
  try {
    return await fn(tracker);
  } finally {
    tracker.detach();
  }
}

describe('console assertion', () => {
  test('clean passes when no errors during step', async () => {
    const page = await freshPage('<html><body><button id="b">go</button></body></html>');
    await withTracker(page, async (tracker) => {
      const snap = tracker.snapshot();
      // Step: click button (no errors fire)
      await page.click('#b');
      const step: Step = { click: '#b' };
      const spec: StepAssert = { console: 'clean' };
      const failures = await evaluateStepAssertions(page, step, spec, snap, tracker, 5);
      assert.equal(failures.length, 0, JSON.stringify(failures));
    });
    await page.close();
  });

  test('clean fails when error logged during step', async () => {
    const page = await freshPage(
      '<html><body><button id="b" onclick="console.error(\'boom\')">boom</button></body></html>',
    );
    await withTracker(page, async (tracker) => {
      const snap = tracker.snapshot();
      await page.click('#b');
      // Give the event loop a tick so the console event is captured
      await page.waitForTimeout(50);
      const step: Step = { click: '#b' };
      const spec: StepAssert = { console: 'clean' };
      const failures = await evaluateStepAssertions(page, step, spec, snap, tracker, 5);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].kind, 'console');
      assert.match(failures[0].message, /boom/);
      assert.match(failures[0].reproducer, /click/);
    });
    await page.close();
  });

  test('allowlist suppresses matching messages', async () => {
    const page = await freshPage(
      '<html><body><button id="b" onclick="console.error(\'ignore-me noise\')">x</button></body></html>',
    );
    await withTracker(page, async (tracker) => {
      const snap = tracker.snapshot();
      await page.click('#b');
      await page.waitForTimeout(50);
      const step: Step = { click: '#b' };
      const spec: StepAssert = { console: { allow: ['ignore-me'] } };
      const failures = await evaluateStepAssertions(page, step, spec, snap, tracker, 5);
      assert.equal(failures.length, 0);
    });
    await page.close();
  });
});

describe('network assertion', () => {
  test('passes for 2xx responses', async () => {
    const page = await context.newPage();
    await page.route('https://uxi.test/**', (route) => {
      const url = route.request().url();
      if (url.endsWith('/ok'))
        return route.fulfill({ status: 200, body: 'ok', contentType: 'text/plain' });
      return route.fulfill({ status: 200, body: '<html></html>', contentType: 'text/html' });
    });
    await page.goto('https://uxi.test/');
    await withTracker(page, async (tracker) => {
      const snap = tracker.snapshot();
      await page.evaluate(() =>
        fetch('https://uxi.test/ok').then((r) => r.text()),
      );
      await page.waitForTimeout(50);
      const step: Step = { eval: "fetch('/ok')" };
      const spec: StepAssert = { network: 'no-4xx' };
      const failures = await evaluateStepAssertions(page, step, spec, snap, tracker, 10);
      assert.equal(failures.length, 0, JSON.stringify(failures));
    });
    await page.close();
  });

  test('fails for 4xx response', async () => {
    const page = await context.newPage();
    await page.route('https://uxi.test/**', (route) => {
      const url = route.request().url();
      if (url.endsWith('/not-found'))
        return route.fulfill({ status: 404, body: 'nope', contentType: 'text/plain' });
      return route.fulfill({ status: 200, body: '<html></html>', contentType: 'text/html' });
    });
    await page.goto('https://uxi.test/');
    await withTracker(page, async (tracker) => {
      const snap = tracker.snapshot();
      await page
        .evaluate(() =>
          fetch('https://uxi.test/not-found').then((r) => r.text()),
        )
        .catch(() => {});
      await page.waitForTimeout(50);
      const step: Step = { eval: "fetch('/not-found')" };
      const spec: StepAssert = { network: 'no-4xx' };
      const failures = await evaluateStepAssertions(page, step, spec, snap, tracker, 10);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].kind, 'network');
      assert.match(failures[0].message, /404/);
      assert.match(failures[0].reproducer, /not-found/);
    });
    await page.close();
  });

  test('allow list suppresses known status', async () => {
    const page = await context.newPage();
    await page.route('https://uxi.test/**', (route) => {
      const url = route.request().url();
      if (url.endsWith('/gone'))
        return route.fulfill({ status: 410, body: 'gone', contentType: 'text/plain' });
      return route.fulfill({ status: 200, body: '<html></html>', contentType: 'text/html' });
    });
    await page.goto('https://uxi.test/');
    await withTracker(page, async (tracker) => {
      const snap = tracker.snapshot();
      await page
        .evaluate(() => fetch('https://uxi.test/gone').then((r) => r.text()))
        .catch(() => {});
      await page.waitForTimeout(50);
      const step: Step = { eval: "fetch('/gone')" };
      const spec: StepAssert = { network: { allow: [410] } };
      const failures = await evaluateStepAssertions(page, step, spec, snap, tracker, 10);
      assert.equal(failures.length, 0);
    });
    await page.close();
  });
});

describe('dom assertion', () => {
  test('mustExist passes when selector present after click', async () => {
    const page = await freshPage(`
      <html><body>
        <button id="reveal" onclick="document.getElementById('box').style.display='block'">r</button>
        <div id="box" style="display:none">hi</div>
      </body></html>
    `);
    await withTracker(page, async (tracker) => {
      const snap = tracker.snapshot();
      await page.click('#reveal');
      const step: Step = { click: '#reveal' };
      const spec: StepAssert = { dom: { selector: '#box', mustExist: true } };
      const failures = await evaluateStepAssertions(page, step, spec, snap, tracker, 5);
      assert.equal(failures.length, 0);
    });
    await page.close();
  });

  test('mustExist fails when selector missing', async () => {
    const page = await freshPage('<html><body><p>empty</p></body></html>');
    await withTracker(page, async (tracker) => {
      const snap = tracker.snapshot();
      const step: Step = { waitFor: 'body' };
      const spec: StepAssert = { dom: { selector: '#nope', mustExist: true } };
      const failures = await evaluateStepAssertions(page, step, spec, snap, tracker, 5);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].kind, 'dom');
    });
    await page.close();
  });

  test('no-error flags role=alert after step', async () => {
    const page = await freshPage(`
      <html><body>
        <button id="b" onclick="document.body.insertAdjacentHTML('beforeend','<div role=alert>Boom</div>')">b</button>
      </body></html>
    `);
    await withTracker(page, async (tracker) => {
      const snap = tracker.snapshot();
      await page.click('#b');
      const step: Step = { click: '#b' };
      const spec: StepAssert = { dom: 'no-error' };
      const failures = await evaluateStepAssertions(page, step, spec, snap, tracker, 5);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].kind, 'dom');
    });
    await page.close();
  });
});

describe('visual assertion', () => {
  test('gracefully handles baseline-not-exist (first run creates baseline)', async () => {
    const page = await freshPage('<html><body style="background:#fff">hi</body></html>');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'uxi-visual-'));
    const origCwd = process.cwd();
    try {
      process.chdir(tmp);
      await withTracker(page, async (tracker) => {
        const snap = tracker.snapshot();
        const step: Step = { waitFor: 'body' };
        const spec: StepAssert = {
          visual: { name: 'first-run-shot', threshold: 0.1 },
        };
        const failures = await evaluateStepAssertions(page, step, spec, snap, tracker, 5);
        // First run: baseline created, checkVisual returns passed=true => no failure
        assert.equal(failures.length, 0, JSON.stringify(failures));
      });
    } finally {
      process.chdir(origCwd);
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
    await page.close();
  });
});

describe('timing assertion', () => {
  test('fails when step exceeds maxMs', async () => {
    const page = await freshPage('<html><body>t</body></html>');
    await withTracker(page, async (tracker) => {
      const snap = tracker.snapshot();
      const step: Step = { sleep: 200 };
      const spec: StepAssert = { timing: { maxMs: 100 } };
      const failures = await evaluateStepAssertions(page, step, spec, snap, tracker, 205);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].kind, 'timing');
      assert.match(failures[0].message, /205/);
    });
    await page.close();
  });

  test('passes when step within maxMs', async () => {
    const page = await freshPage('<html><body>t</body></html>');
    await withTracker(page, async (tracker) => {
      const snap = tracker.snapshot();
      const step: Step = { sleep: 10 };
      const spec: StepAssert = { timing: { maxMs: 1000 } };
      const failures = await evaluateStepAssertions(page, step, spec, snap, tracker, 12);
      assert.equal(failures.length, 0);
    });
    await page.close();
  });
});
