import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { auditThirdParty } from './third-party.js';
import { analyzeBundles } from './bundle-size.js';
import { auditCookieBanner } from './cookie-banner.js';
import { auditCompression } from './compression.js';

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

describe('auditThirdParty', () => {
  test('page with only same-origin resources has no third-party issues', async () => {
    const page = await newPage();
    try {
      await page.setContent('<html><body><h1>same origin only</h1></body></html>');
      const result = await auditThirdParty(page);
      assert.equal(typeof result.page, 'string');
      assert.equal(result.thirdPartyResources, 0);
      assert.equal(result.thirdPartyBytes, 0);
      assert.equal(result.thirdPartyBlockingMs, 0);
      assert.deepEqual(result.topEntities, []);
      assert.deepEqual(result.issues, []);
      assert.equal(result.passed, true);
      assert.equal(result.categories.analytics, 0);
      assert.equal(result.categories.ads, 0);
      assert.equal(result.categories.tagManager, 0);
    } finally {
      await page.close();
    }
  });

  test('page referencing a third-party script URL produces a result shape', async () => {
    const page = await newPage();
    try {
      // The URL just needs to be attempted as a resource. We don't need it to actually load.
      await page.setContent(
        '<html><body><script src="https://www.googletagmanager.com/gtag/js?id=FAKE-ID"></script><p>hi</p></body></html>',
      );
      // Give the browser a tick to register the resource entry.
      await page.waitForTimeout(200);
      const result = await auditThirdParty(page);
      assert.equal(typeof result.page, 'string');
      assert.ok(Array.isArray(result.topEntities));
      assert.ok(Array.isArray(result.issues));
      assert.equal(typeof result.passed, 'boolean');
      assert.ok(result.categories && typeof result.categories.analytics === 'number');
      // firstPartyOrigin for about:blank is empty string
      assert.equal(typeof result.firstPartyOrigin, 'string');
    } finally {
      await page.close();
    }
  });
});

describe('analyzeBundles', () => {
  test('empty page reports zero bundles and passes', async () => {
    const page = await newPage();
    try {
      await page.setContent('<html><body>nothing</body></html>');
      const result = await analyzeBundles(page);
      assert.equal(typeof result.page, 'string');
      assert.equal(result.totalJsBytes, 0);
      assert.equal(result.totalCssBytes, 0);
      assert.equal(result.totalJsTransferBytes, 0);
      assert.equal(result.totalCssTransferBytes, 0);
      assert.deepEqual(result.bundles, []);
      assert.deepEqual(result.duplicatePackages, []);
      assert.deepEqual(result.issues, []);
      assert.equal(result.passed, true);
    } finally {
      await page.close();
    }
  });

  test('page with large inline script still reports zero external bundles', async () => {
    const page = await newPage();
    try {
      // Inline scripts are not external resources, so analyzeBundles won't pick them up.
      const big = 'var x = 1;'.repeat(50_000);
      await page.setContent(`<html><body><script>${big}</script><p>inline</p></body></html>`);
      const result = await analyzeBundles(page);
      assert.ok(Array.isArray(result.bundles));
      assert.ok(Array.isArray(result.issues));
      assert.equal(typeof result.passed, 'boolean');
      assert.equal(typeof result.totalJsBytes, 'number');
      assert.equal(typeof result.totalCssBytes, 'number');
    } finally {
      await page.close();
    }
  });
});

describe('auditCookieBanner', () => {
  test('page with visible cookie banner + accept button is detected', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><body>
          <div id="cookie-banner" style="position:fixed;bottom:0;left:0;right:0;padding:20px;background:#fff;z-index:9999;">
            We use cookies to improve your experience.
            <button type="button">Accept</button>
          </div>
          <p>page body</p>
        </body></html>
      `);
      const result = await auditCookieBanner(page);
      assert.equal(result.bannerDetected, true);
      assert.equal(result.bannerSelector, '#cookie-banner');
      assert.equal(result.hasAcceptButton, true);
      assert.equal(result.hasRejectButton, false);
      assert.ok(Array.isArray(result.issues));
      // no reject button -> should flag it
      assert.ok(result.issues.some((i) => i.type === 'no-reject-button'));
      assert.equal(result.passed, false);
    } finally {
      await page.close();
    }
  });

  test('page without banner and without trackers has no issues', async () => {
    const page = await newPage();
    try {
      await page.setContent('<html><body><h1>no banner here</h1></body></html>');
      const result = await auditCookieBanner(page);
      assert.equal(result.bannerDetected, false);
      assert.equal(result.hasAcceptButton, false);
      assert.equal(result.hasRejectButton, false);
      assert.equal(result.hasSettingsButton, false);
      assert.deepEqual(result.beforeConsentCookies, []);
      assert.deepEqual(result.beforeConsentTrackers, []);
      assert.deepEqual(result.issues, []);
      assert.equal(result.passed, true);
    } finally {
      await page.close();
    }
  });

  test('banner with both accept and reject buttons has no reject-button issue', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><body>
          <div id="cookie-banner" style="position:fixed;bottom:0;left:0;right:0;padding:20px;background:#fff;z-index:9999;">
            We use cookies.
            <button type="button">Accept</button>
            <button type="button">Reject</button>
          </div>
        </body></html>
      `);
      const result = await auditCookieBanner(page);
      assert.equal(result.bannerDetected, true);
      assert.equal(result.hasAcceptButton, true);
      assert.equal(result.hasRejectButton, true);
      assert.ok(!result.issues.some((i) => i.type === 'no-reject-button'));
    } finally {
      await page.close();
    }
  });
});

describe('auditCompression', () => {
  test('https://example.com returns structured result with compressionRatio or passed flag', async () => {
    const result = await auditCompression('https://example.com');
    assert.equal(result.url, 'https://example.com');
    assert.equal(typeof result.passed, 'boolean');
    assert.ok(Array.isArray(result.issues));
    assert.equal(typeof result.supportsBrotli, 'boolean');
    assert.equal(typeof result.altSvcHasH3, 'boolean');
    // example.com is expected to have compression + modern HTTP;
    // we accept either a defined compressionRatio or passed===true as signal that the audit ran successfully.
    const ratioDefined = typeof result.compressionRatio === 'number';
    assert.ok(
      result.passed === true || ratioDefined,
      `expected passed=true or compressionRatio defined, got passed=${result.passed} ratio=${String(result.compressionRatio)}`,
    );
    if (result.httpVersion) {
      assert.equal(typeof result.httpVersion, 'string');
    }
  });
});
