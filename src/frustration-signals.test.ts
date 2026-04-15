import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { attachFrustrationSignals } from './frustration-signals.js';

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

async function newPage(): Promise<Page> {
  return context.newPage();
}

async function gotoHtml(page: Page, html: string): Promise<void> {
  // addInitScript only fires on a real navigation, so go to a data URL rather
  // than setContent on the about:blank initial document.
  await page.goto('data:text/html,' + encodeURIComponent(html), { waitUntil: 'load' });
}

describe('attachFrustrationSignals — rage-click', () => {
  test('3 rapid clicks on the same button produce a rage-click finding', async () => {
    const page = await newPage();
    try {
      const handle = await attachFrustrationSignals(page, { rageClickWindowMs: 600 });
      await gotoHtml(
        page,
        `<html><body><button id="idle" style="width:200px;height:80px">Do nothing</button></body></html>`,
      );

      const btn = page.locator('#idle');
      for (let i = 0; i < 3; i++) {
        await btn.click({ force: true });
      }
      await page.waitForTimeout(150);

      const result = await handle.result();
      handle.detach();

      assert.ok(result.clicksObserved >= 3, `expected 3 clicks, saw ${result.clicksObserved}`);
      assert.ok(result.rageClicks.length >= 1, 'expected at least one rage-click');
      const rc = result.rageClicks[0]!;
      assert.equal(rc.selector, '#idle');
      const ev = rc.evidence as { clicksInWindow: number; windowMs: number };
      assert.ok(ev.clicksInWindow >= 3);
      assert.ok(ev.windowMs >= 0);
      assert.equal(result.passed, false);
    } finally {
      await page.close();
    }
  });
});

describe('attachFrustrationSignals — dead-click', () => {
  test('click on a button with no handler + no side-effect produces a dead-click finding', async () => {
    const page = await newPage();
    try {
      const handle = await attachFrustrationSignals(page, { deadClickWaitMs: 300 });
      await gotoHtml(
        page,
        `<html><body><button id="dead" style="width:200px;height:80px">Dead</button></body></html>`,
      );

      await page.locator('#dead').click({ force: true });
      // Wait longer than deadClickWaitMs so the in-page timer records side-effect state.
      await page.waitForTimeout(400);

      const result = await handle.result();
      handle.detach();

      assert.ok(result.deadClicks.length >= 1, 'expected a dead-click');
      const dc = result.deadClicks.find((d) => d.selector === '#dead');
      assert.ok(dc, 'expected dead-click for #dead');
      assert.equal(result.passed, false);
    } finally {
      await page.close();
    }
  });

  test('click that causes a DOM mutation is NOT a dead-click', async () => {
    const page = await newPage();
    try {
      const handle = await attachFrustrationSignals(page, { deadClickWaitMs: 300 });
      await gotoHtml(
        page,
        `<html><body>
          <button id="alive" style="width:200px;height:80px"
            onclick="document.getElementById('out').textContent = 'hit';">Alive</button>
          <div id="out"></div>
        </body></html>`,
      );

      await page.locator('#alive').click({ force: true });
      await page.waitForTimeout(400);

      const result = await handle.result();
      handle.detach();

      const dc = result.deadClicks.find((d) => d.selector === '#alive');
      assert.equal(dc, undefined, 'alive button should not be flagged dead');
    } finally {
      await page.close();
    }
  });
});

describe('attachFrustrationSignals — u-turn', () => {
  test('navigation forward followed by history.back within window produces a u-turn', async () => {
    const page = await newPage();
    // Route two fake pages on the same origin so pushState/history.back work.
    await page.route('http://uxinspect.test/**', async (route) => {
      const url = route.request().url();
      const body =
        url.endsWith('/detail')
          ? `<html><body><h1>Detail</h1><button id="back" onclick="history.back()">Back</button></body></html>`
          : `<html><body><h1>Home</h1>
              <a id="go" href="/detail">Go detail</a>
            </body></html>`;
      await route.fulfill({ status: 200, contentType: 'text/html', body });
    });

    try {
      const handle = await attachFrustrationSignals(page, { uTurnWindowMs: 5000 });
      await page.goto('http://uxinspect.test/', { waitUntil: 'load' });
      await page.locator('#go').click();
      await page.waitForLoadState('load');
      await page.waitForTimeout(100);
      await page.locator('#back').click();
      await page.waitForTimeout(400);

      const result = await handle.result();
      handle.detach();

      assert.ok(result.navigationsObserved >= 1, 'expected at least one navigation');
      assert.ok(result.uTurns.length >= 1, 'expected a u-turn finding');
      const evidence = result.uTurns[0]!.evidence as { returnedAfterMs: number };
      assert.ok(evidence.returnedAfterMs >= 0);
      assert.ok(evidence.returnedAfterMs <= 5000);
    } finally {
      await page.close();
    }
  });
});

describe('attachFrustrationSignals — error-click', () => {
  test('click that triggers a console.error within window produces an error-click', async () => {
    const page = await newPage();
    try {
      const handle = await attachFrustrationSignals(page, { errorClickWindowMs: 1000, deadClickWaitMs: 200 });
      await gotoHtml(
        page,
        `<html><body>
          <button id="boom" onclick="console.error('synthetic failure')">Boom</button>
        </body></html>`,
      );

      await page.locator('#boom').click({ force: true });
      await page.waitForTimeout(300);

      const result = await handle.result();
      handle.detach();

      assert.ok(result.errorClicks.length >= 1, 'expected an error-click');
      const ec = result.errorClicks[0]!;
      assert.equal(ec.selector, '#boom');
      const ev = ec.evidence as { errorMessage: string };
      assert.match(ev.errorMessage, /synthetic failure/);
    } finally {
      await page.close();
    }
  });
});

describe('attachFrustrationSignals — clean run', () => {
  test('a benign page with no interactions passes', async () => {
    const page = await newPage();
    try {
      const handle = await attachFrustrationSignals(page);
      await gotoHtml(page, '<html><body><p>Hello</p></body></html>');
      await page.waitForTimeout(100);

      const result = await handle.result();
      handle.detach();

      assert.equal(result.rageClicks.length, 0);
      assert.equal(result.deadClicks.length, 0);
      assert.equal(result.uTurns.length, 0);
      assert.equal(result.errorClicks.length, 0);
      assert.equal(result.thrashedCursors.length, 0);
      assert.equal(result.passed, true);
    } finally {
      await page.close();
    }
  });
});
