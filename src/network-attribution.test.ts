/**
 * P0 #6 — Per-click network-failure attribution.
 *
 * startCapture(page) wraps a Playwright page with beginStep/endStep windows.
 * 4xx/5xx responses arriving inside a window are attributed to that step;
 * responses arriving outside are dropped. endStep drains in-flight response
 * handlers so fast teardown does not lose failures.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { startCapture } from './network-attribution.js';

let browser: Browser;
let context: BrowserContext;

before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
});

after(async () => {
  await context?.close();
  await browser?.close();
});

async function routeStatus(
  page: import('playwright').Page,
  pattern: string,
  status: number,
  delayMs = 0,
): Promise<void> {
  await page.route(pattern, async (route) => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    await route.fulfill({ status, body: 'x' });
  });
}

test('attributes 4xx to the active step only', async () => {
  const page = await context.newPage();
  const cap = startCapture(page);
  try {
    await page.setContent('<html><body></body></html>');
    await routeStatus(page, '**/missing', 404);

    cap.beginStep('step-0');
    await page.evaluate(() => fetch('https://example.com/missing').catch(() => {}));
    const failures = await cap.endStep();

    assert.equal(failures.length, 1);
    assert.equal(failures[0].status, 404);
    assert.match(failures[0].url, /\/missing/);
  } finally {
    cap.stopCapture();
    await page.close();
  }
});

test('ignores 2xx and 3xx responses', async () => {
  const page = await context.newPage();
  const cap = startCapture(page);
  try {
    await page.setContent('<html><body></body></html>');
    await routeStatus(page, '**/ok', 200);
    await routeStatus(page, '**/redir', 301);

    cap.beginStep('step-0');
    await page.evaluate(() => fetch('https://example.com/ok').catch(() => {}));
    await page.evaluate(() => fetch('https://example.com/redir').catch(() => {}));
    const failures = await cap.endStep();

    assert.equal(failures.length, 0);
  } finally {
    cap.stopCapture();
    await page.close();
  }
});

test('captures 5xx with method + url + requestId', async () => {
  const page = await context.newPage();
  const cap = startCapture(page);
  try {
    await page.setContent('<html><body></body></html>');
    await routeStatus(page, '**/crash', 500);

    cap.beginStep('step-0');
    await page.evaluate(() =>
      fetch('https://example.com/crash', { method: 'POST' }).catch(() => {}),
    );
    const failures = await cap.endStep();

    assert.equal(failures.length, 1);
    assert.equal(failures[0].status, 500);
    assert.equal(failures[0].method, 'POST');
    assert.ok(failures[0].requestId);
    assert.ok(typeof failures[0].timestamp === 'number' && failures[0].timestamp > 0);
  } finally {
    cap.stopCapture();
    await page.close();
  }
});

test('drops responses that arrive while no step is active', async () => {
  const page = await context.newPage();
  const cap = startCapture(page);
  try {
    await page.setContent('<html><body></body></html>');
    await routeStatus(page, '**/late', 404);
    // No beginStep — any 4xx should be dropped.
    await page.evaluate(() => fetch('https://example.com/late').catch(() => {}));
    // Brief settle — response processing happens async in the page.
    await page.waitForTimeout(50);

    cap.beginStep('later-step');
    const failures = await cap.endStep();
    assert.equal(failures.length, 0);
  } finally {
    cap.stopCapture();
    await page.close();
  }
});

test('separates failures across consecutive steps', async () => {
  const page = await context.newPage();
  const cap = startCapture(page);
  try {
    await page.setContent('<html><body></body></html>');
    await routeStatus(page, '**/a-fail', 404);
    await routeStatus(page, '**/b-fail', 500);

    cap.beginStep('a');
    await page.evaluate(() => fetch('https://example.com/a-fail').catch(() => {}));
    const stepA = await cap.endStep();

    cap.beginStep('b');
    await page.evaluate(() => fetch('https://example.com/b-fail').catch(() => {}));
    const stepB = await cap.endStep();

    assert.equal(stepA.length, 1);
    assert.equal(stepA[0].status, 404);
    assert.equal(stepB.length, 1);
    assert.equal(stepB[0].status, 500);
  } finally {
    cap.stopCapture();
    await page.close();
  }
});

test('endStep drains in-flight responses', async () => {
  const page = await context.newPage();
  const cap = startCapture(page);
  try {
    await page.setContent('<html><body></body></html>');
    // 80ms delay so the fulfill resolves after our fetch but we endStep very soon after.
    await routeStatus(page, '**/slow-fail', 503, 80);

    cap.beginStep('slow');
    // Kick off the fetch and immediately await endStep — endStep must await the
    // in-flight worker so the failure is not dropped.
    const fetchPromise = page.evaluate(() =>
      fetch('https://example.com/slow-fail').catch(() => {}),
    );
    // Give the event loop a beat so the response handler is wired before we close.
    await page.waitForTimeout(120);
    await fetchPromise;
    const failures = await cap.endStep();

    assert.equal(failures.length, 1);
    assert.equal(failures[0].status, 503);
  } finally {
    cap.stopCapture();
    await page.close();
  }
});

test('stopCapture is idempotent', async () => {
  const page = await context.newPage();
  const cap = startCapture(page);
  cap.stopCapture();
  cap.stopCapture(); // no throw
  // beginStep after stop is a no-op.
  cap.beginStep('after-stop');
  assert.equal((await cap.endStep()).length, 0);
  await page.close();
});
