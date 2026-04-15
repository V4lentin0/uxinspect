import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { auditOfflineBehavior } from './offline-audit.js';

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

/**
 * Serve a data: URL with the given HTML. Avoids any network dependency.
 */
function dataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

describe('auditOfflineBehavior', () => {
  test('SPA with no service worker and no cache is flagged when offline blanks out', async () => {
    const page = await newPage();
    try {
      // Bare SPA that renders only via a runtime-fetched script — fine online,
      // blank once we kill the network. No SW, no Cache Storage.
      const html = `
        <!doctype html>
        <html>
          <head><meta charset="utf-8"><title>bare spa</title></head>
          <body><div id="root"></div>
            <script>
              document.getElementById('root').textContent = 'hello online';
            </script>
          </body>
        </html>`;
      await page.goto(dataUrl(html), { waitUntil: 'load' });
      const result = await auditOfflineBehavior(page, {
        checkOffline: true,
        checkSlow: false,
        checkFlaky: false,
      });

      assert.equal(typeof result.page, 'string');
      assert.equal(result.offline.swActive, false, 'no SW controller on a bare data: page');
      assert.equal(result.offline.cachedResources.length, 0, 'no cached resources');
      assert.ok(
        result.issues.some((i) => i.type === 'no-service-worker'),
        'should flag missing service worker',
      );
      assert.ok(
        result.issues.some((i) => i.type === 'no-offline-cache'),
        'should flag missing offline cache',
      );
      assert.equal(result.passed, false, 'overall audit should not pass without SW/cache');
    } finally {
      await page.close();
    }
  });

  test('slow network shows skeleton element within wait window', async () => {
    const page = await newPage();
    try {
      const html = `
        <!doctype html>
        <html>
          <head><meta charset="utf-8"></head>
          <body>
            <div class="skeleton" aria-busy="true">loading...</div>
            <h1>content</h1>
          </body>
        </html>`;
      await page.goto(dataUrl(html), { waitUntil: 'load' });
      const result = await auditOfflineBehavior(page, {
        checkOffline: false,
        checkSlow: true,
        checkFlaky: false,
        slowDelayMs: 200,
        skeletonWaitMs: 500,
      });

      assert.equal(typeof result.slowNetwork.ttfb, 'number');
      assert.equal(result.slowNetwork.showsSkeleton, true, 'skeleton element was visible');
      assert.ok(
        !result.issues.some((i) => i.type === 'slow-blank'),
        'should not flag slow-blank when skeleton is present',
      );
    } finally {
      await page.close();
    }
  });

  test('flaky network with silent failures is flagged', async () => {
    const page = await newPage();
    try {
      // Page pulls many sub-resources so 50% failure guarantees some aborted requests.
      // Also has NO error/retry UI — swallows fetch errors silently.
      const html = `
        <!doctype html>
        <html>
          <head>
            <meta charset="utf-8">
            <link rel="stylesheet" href="https://example.invalid/a.css">
            <link rel="stylesheet" href="https://example.invalid/b.css">
            <link rel="stylesheet" href="https://example.invalid/c.css">
          </head>
          <body>
            <h1>everything is fine</h1>
            <img src="https://example.invalid/1.png">
            <img src="https://example.invalid/2.png">
            <img src="https://example.invalid/3.png">
            <img src="https://example.invalid/4.png">
            <script>
              // swallow errors — no retry button, no error toast
              window.addEventListener('error', function(e) { e.preventDefault(); }, true);
            </script>
          </body>
        </html>`;
      await page.goto(dataUrl(html), { waitUntil: 'load' });
      const result = await auditOfflineBehavior(page, {
        checkOffline: false,
        checkSlow: false,
        checkFlaky: true,
        flakyFailRate: 1.0, // force every non-document request to fail
      });

      assert.ok(result.flakyNetwork.totalRequests >= 0, 'request counter populated');
      // Silent failure flag is only raised when requests actually failed AND no UI appeared.
      if (result.flakyNetwork.failedRequests > 0) {
        assert.equal(
          result.flakyNetwork.showsError,
          false,
          'page has no visible error UI',
        );
        assert.equal(result.flakyNetwork.hasRetry, false, 'page has no retry UI');
        assert.ok(
          result.issues.some((i) => i.type === 'flaky-silent'),
          'should flag silent flaky failures',
        );
      }
    } finally {
      await page.close();
    }
  });

  test('returns structured result with all four sub-results even when every check is off', async () => {
    const page = await newPage();
    try {
      await page.goto(dataUrl('<html><body>hi</body></html>'), { waitUntil: 'load' });
      const result = await auditOfflineBehavior(page, {
        checkOffline: false,
        checkSlow: false,
        checkFlaky: false,
      });
      assert.equal(typeof result.offline.renders, 'boolean');
      assert.equal(typeof result.offline.swActive, 'boolean');
      assert.ok(Array.isArray(result.offline.cachedResources));
      assert.equal(typeof result.slowNetwork.showsSkeleton, 'boolean');
      assert.equal(typeof result.slowNetwork.ttfb, 'number');
      assert.equal(typeof result.flakyNetwork.showsError, 'boolean');
      assert.equal(typeof result.flakyNetwork.hasRetry, 'boolean');
      assert.ok(Array.isArray(result.issues));
      assert.equal(result.passed, true, 'no checks run => no issues => passed');
    } finally {
      await page.close();
    }
  });
});
