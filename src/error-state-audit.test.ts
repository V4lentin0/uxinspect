import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import {
  auditErrorStateAppearance,
  snapshotErrorState,
  diffErrorStateAppearance,
  DEFAULT_ERROR_STATE_SELECTORS,
} from './error-state-audit.js';

let browser: Browser | undefined;
let context: BrowserContext | undefined;

before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
});

after(async () => {
  await context?.close();
  await browser?.close();
});

async function newPage(): Promise<Page> {
  if (!context) throw new Error('browser context not ready');
  return context.newPage();
}

describe('auditErrorStateAppearance', () => {
  test('baseline snapshot on clean page reports no new errors', async () => {
    const page = await newPage();
    try {
      await page.setContent('<html><body><h1>hello</h1></body></html>');
      const result = await auditErrorStateAppearance(page);
      assert.equal(result.passed, true);
      assert.equal(result.newErrors.length, 0);
      assert.equal(result.checked, DEFAULT_ERROR_STATE_SELECTORS.length);
    } finally {
      await page.close();
    }
  });

  test('allowExisting:false on page with existing error element flags them', async () => {
    const page = await newPage();
    try {
      await page.setContent(
        '<html><body><div role="alert">Something broke</div></body></html>',
      );
      const result = await auditErrorStateAppearance(page, { allowExisting: false });
      assert.equal(result.passed, false);
      assert.ok(result.newErrors.length >= 1);
      assert.equal(result.newErrors[0]!.selector, '[role="alert"]');
      assert.ok(result.newErrors[0]!.text.includes('Something broke'));
    } finally {
      await page.close();
    }
  });

  test('custom selectors list is used when provided', async () => {
    const page = await newPage();
    try {
      await page.setContent('<html><body><div class="my-bad">x</div></body></html>');
      const result = await auditErrorStateAppearance(page, {
        selectors: ['.my-bad'],
        allowExisting: false,
      });
      assert.equal(result.checked, 1);
      assert.equal(result.passed, false);
      assert.equal(result.newErrors[0]!.selector, '.my-bad');
    } finally {
      await page.close();
    }
  });
});

describe('snapshot + diff error state (click flows)', () => {
  test('click that reveals error toast is flagged by diff', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><body>
          <button id="boom">Break it</button>
          <div id="msgs"></div>
          <script>
            document.getElementById('boom').addEventListener('click', () => {
              const el = document.createElement('div');
              el.className = 'toast-error';
              el.textContent = 'Request failed';
              document.getElementById('msgs').appendChild(el);
            });
          </script>
        </body></html>
      `);
      const before = await snapshotErrorState(page);
      await page.click('#boom');
      await page.waitForTimeout(50);
      const diff = await diffErrorStateAppearance(page, before);
      assert.equal(diff.passed, false);
      assert.equal(diff.newErrors.length, 1);
      assert.equal(diff.newErrors[0]!.selector, '.toast-error');
      assert.ok(diff.newErrors[0]!.text.includes('Request failed'));
    } finally {
      await page.close();
    }
  });

  test('click that does nothing is NOT flagged', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><body>
          <button id="noop">Benign</button>
          <p>static content</p>
        </body></html>
      `);
      const before = await snapshotErrorState(page);
      await page.click('#noop');
      await page.waitForTimeout(50);
      const diff = await diffErrorStateAppearance(page, before);
      assert.equal(diff.passed, true);
      assert.equal(diff.newErrors.length, 0);
    } finally {
      await page.close();
    }
  });

  test('existing error element present before click is NOT re-flagged', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><body>
          <div role="alert">pre-existing error</div>
          <button id="noop">Benign</button>
        </body></html>
      `);
      const before = await snapshotErrorState(page);
      await page.click('#noop');
      await page.waitForTimeout(50);
      const diff = await diffErrorStateAppearance(page, before);
      assert.equal(diff.passed, true);
      assert.equal(diff.newErrors.length, 0);
    } finally {
      await page.close();
    }
  });

  test('aria-invalid toggling on existing input is flagged after click', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><body>
          <input id="inp" aria-invalid="false" />
          <button id="submit">Submit</button>
          <script>
            document.getElementById('submit').addEventListener('click', () => {
              document.getElementById('inp').setAttribute('aria-invalid', 'true');
            });
          </script>
        </body></html>
      `);
      const before = await snapshotErrorState(page);
      await page.click('#submit');
      await page.waitForTimeout(50);
      const diff = await diffErrorStateAppearance(page, before);
      assert.equal(diff.passed, false);
      assert.ok(diff.newErrors.some((e) => e.selector === '[aria-invalid="true"]'));
    } finally {
      await page.close();
    }
  });

  test('hidden error elements are ignored', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><body>
          <div class="error" style="display:none">hidden err</div>
          <button id="noop">x</button>
        </body></html>
      `);
      const before = await snapshotErrorState(page);
      await page.click('#noop');
      const diff = await diffErrorStateAppearance(page, before);
      assert.equal(diff.passed, true);
      assert.equal(diff.newErrors.length, 0);
    } finally {
      await page.close();
    }
  });
});
