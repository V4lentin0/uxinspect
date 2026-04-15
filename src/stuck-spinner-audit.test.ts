import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  auditStuckSpinners,
  DEFAULT_STUCK_SPINNER_SELECTORS,
} from './stuck-spinner-audit.js';

let browser: Browser;
let context: BrowserContext;

before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
});

after(async () => {
  await context?.close();
  await browser?.close();
});

async function newPage(): Promise<Page> {
  return context.newPage();
}

describe('auditStuckSpinners', () => {
  test('flags a spinner that remains visible past the timeout', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><body>
          <div class="spinner" style="width:40px;height:40px;background:#eee;">loading</div>
          <p>content</p>
        </body></html>
      `);
      const result = await auditStuckSpinners(page, {
        timeoutMs: 1500,
        pollIntervalMs: 100,
        captureScreenshot: false,
      });
      assert.equal(result.passed, false);
      assert.ok(result.stuck.length >= 1, 'expected at least one stuck finding');
      const finding = result.stuck.find((s) => s.selector === '.spinner');
      assert.ok(finding, 'expected a .spinner finding');
      assert.ok(finding.durationMs >= 1500, `durationMs ${finding.durationMs} should be >= timeout`);
      assert.ok(finding.snippet.includes('spinner'));
      assert.equal(typeof result.checkedAt, 'string');
    } finally {
      await page.close();
    }
  });

  test('does NOT flag a spinner that disappears before the timeout', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><body>
          <div id="sp" class="spinner" style="width:40px;height:40px;">loading</div>
          <script>
            setTimeout(function(){
              var el = document.getElementById('sp');
              if (el) el.parentNode.removeChild(el);
            }, 300);
          </script>
        </body></html>
      `);
      const result = await auditStuckSpinners(page, {
        timeoutMs: 1500,
        pollIntervalMs: 100,
        captureScreenshot: false,
      });
      assert.equal(result.passed, true);
      assert.equal(result.stuck.length, 0, `expected no stuck findings, got ${result.stuck.length}`);
    } finally {
      await page.close();
    }
  });

  test('flags aria-busy="true" when stuck', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><body>
          <section aria-busy="true" style="width:100px;height:30px;">loading region</section>
        </body></html>
      `);
      const result = await auditStuckSpinners(page, {
        timeoutMs: 400,
        pollIntervalMs: 100,
        captureScreenshot: false,
      });
      assert.equal(result.passed, false);
      assert.ok(result.stuck.some((s) => s.selector === '[aria-busy="true"]'));
    } finally {
      await page.close();
    }
  });

  test('honors custom selectors (not defaults)', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><body>
          <!-- default selector: should NOT flag because we override -->
          <div class="spinner" style="width:40px;height:40px;">default</div>
          <!-- custom selector -->
          <div class="my-busy-widget" style="width:40px;height:40px;">custom</div>
        </body></html>
      `);
      const result = await auditStuckSpinners(page, {
        timeoutMs: 400,
        pollIntervalMs: 100,
        captureScreenshot: false,
        selectors: ['.my-busy-widget'],
      });
      assert.equal(result.passed, false);
      assert.equal(result.stuck.length, 1);
      assert.equal(result.stuck[0].selector, '.my-busy-widget');
    } finally {
      await page.close();
    }
  });

  test('custom timeoutMs respected: short timeout flags quickly', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><body>
          <div class="loader" style="width:40px;height:40px;">loader</div>
        </body></html>
      `);
      const started = Date.now();
      const result = await auditStuckSpinners(page, {
        timeoutMs: 200,
        pollIntervalMs: 50,
        captureScreenshot: false,
      });
      const elapsed = Date.now() - started;
      assert.equal(result.passed, false);
      assert.ok(result.stuck.some((s) => s.selector === '.loader'));
      // total duration should be roughly timeoutMs plus a small buffer, not >> that
      assert.ok(elapsed < 2000, `audit took too long: ${elapsed}ms`);
    } finally {
      await page.close();
    }
  });

  test('ignores hidden (display:none) elements matching a selector', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><body>
          <div class="spinner" style="display:none;">hidden spinner</div>
          <p>content</p>
        </body></html>
      `);
      const result = await auditStuckSpinners(page, {
        timeoutMs: 400,
        pollIntervalMs: 100,
        captureScreenshot: false,
      });
      assert.equal(result.passed, true);
      assert.equal(result.stuck.length, 0);
    } finally {
      await page.close();
    }
  });

  test('exports default selector list', () => {
    assert.ok(Array.isArray(DEFAULT_STUCK_SPINNER_SELECTORS));
    assert.ok(DEFAULT_STUCK_SPINNER_SELECTORS.includes('[aria-busy="true"]'));
    assert.ok(DEFAULT_STUCK_SPINNER_SELECTORS.includes('.spinner'));
    assert.ok(DEFAULT_STUCK_SPINNER_SELECTORS.includes('.skeleton'));
  });
});
