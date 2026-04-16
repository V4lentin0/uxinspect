import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { runOfflineAudit } from './offline-audit.js';

let browser: Browser | undefined;
let context: BrowserContext | undefined;

interface Fixture {
  url: string;
  close: () => Promise<void>;
  setBody: (html: string) => void;
}

/**
 * Lightweight local HTTP fixture — lets us test real navigation and real
 * offline semantics without touching the public internet.
 */
async function startFixture(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Fixture> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind fixture server');
  const url = `http://127.0.0.1:${addr.port}`;
  return {
    url,
    setBody: () => {},
    close: (): Promise<void> =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function simpleHtmlFixture(html: string): Promise<Fixture> {
  return startFixture((req, res) => {
    if (req.url === '/slow-asset') {
      // stay open briefly to simulate slow asset
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      }, 1000);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
}

before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
});

after(async () => {
  await context?.close();
  await browser?.close();
});

async function newPage(): Promise<Page> {
  if (!context) throw new Error('browser context not ready');
  return context.newPage();
}

describe('runOfflineAudit', () => {
  test('flags browser-error page when offline with no SW cache', async () => {
    const fixture = await simpleHtmlFixture('<html><body><h1>live</h1></body></html>');
    const page = await newPage();
    try {
      await page.goto(fixture.url);
      const result = await runOfflineAudit(page, {
        // Skip heavy / env-specific scenarios so the assertion stays tight.
        skipScenarios: ['slow-3g', 'intermittent', 'offline-mutations', 'swr', 'sw-update'],
        expectSwAt: fixture.url,
        navigationTimeoutMs: 4000,
      });
      const full = result.scenarios.find((s) => s.id === 'full-offline');
      assert.ok(full, 'full-offline scenario should run');
      assert.equal(full.status, 'failed', 'no SW should produce a failed full-offline scenario');
      assert.ok(
        result.issues.some(
          (i) =>
            i.scenario === 'full-offline' &&
            (i.type === 'browser-error-page-offline' || i.type === 'offline-navigation-failed'),
        ),
        'an offline navigation issue should be raised',
      );
      assert.equal(result.passed, false);
      assert.equal(result.serviceWorkerDetected, false);
    } finally {
      await page.close();
      await fixture.close();
    }
  });

  test('slow-3g scenario applies CDP throttling and reports load time', async () => {
    const fixture = await simpleHtmlFixture(
      '<html><body><div class="spinner" style="width:40px;height:40px;">loading</div><h1>content</h1></body></html>',
    );
    const page = await newPage();
    try {
      await page.goto(fixture.url);
      const result = await runOfflineAudit(page, {
        skipScenarios: ['full-offline', 'intermittent', 'offline-mutations', 'swr', 'sw-update'],
        expectSwAt: fixture.url,
        navigationTimeoutMs: 10000,
      });
      const slow = result.scenarios.find((s) => s.id === 'slow-3g');
      assert.ok(slow, 'slow-3g scenario should run');
      assert.notEqual(slow.status, 'skipped', 'chromium should accept CDP throttle');
      assert.ok(slow.metrics, 'slow-3g should report metrics');
      assert.equal((slow.metrics as any).downloadBps, (400 * 1024) / 8);
      assert.equal((slow.metrics as any).latencyMs, 400);
      assert.ok(typeof (slow.metrics as any).loadTimeMs === 'number');
    } finally {
      await page.close();
      await fixture.close();
    }
  });

  test('intermittent scenario survives offline/online flap without throwing', async () => {
    const fixture = await simpleHtmlFixture('<html><body><main>ok</main></body></html>');
    const page = await newPage();
    try {
      await page.goto(fixture.url);
      const result = await runOfflineAudit(page, {
        skipScenarios: ['full-offline', 'slow-3g', 'offline-mutations', 'swr', 'sw-update'],
        expectSwAt: fixture.url,
        navigationTimeoutMs: 6000,
      });
      const inter = result.scenarios.find((s) => s.id === 'intermittent');
      assert.ok(inter, 'intermittent scenario should run');
      assert.ok(
        inter.status === 'passed' || inter.status === 'failed',
        `intermittent should complete (got ${inter.status})`,
      );
      assert.ok(inter.metrics, 'intermittent should report metrics');
      assert.equal((inter.metrics as any).flapCycles, 3);
    } finally {
      await page.close();
      await fixture.close();
    }
  });

  test('offline-mutations returns N/A without SW or form selector', async () => {
    const fixture = await simpleHtmlFixture('<html><body><h1>no forms here</h1></body></html>');
    const page = await newPage();
    try {
      await page.goto(fixture.url);
      const result = await runOfflineAudit(page, {
        skipScenarios: ['full-offline', 'slow-3g', 'intermittent', 'swr', 'sw-update'],
        expectSwAt: fixture.url,
      });
      const mut = result.scenarios.find((s) => s.id === 'offline-mutations');
      assert.ok(mut, 'offline-mutations should always appear');
      assert.equal(mut.status, 'na');
      assert.match(mut.note ?? '', /form|service worker/i);
    } finally {
      await page.close();
      await fixture.close();
    }
  });

  test('swr and sw-update are N/A when no SW is registered', async () => {
    const fixture = await simpleHtmlFixture('<html><body><h1>plain</h1></body></html>');
    const page = await newPage();
    try {
      await page.goto(fixture.url);
      const result = await runOfflineAudit(page, {
        skipScenarios: ['full-offline', 'slow-3g', 'intermittent', 'offline-mutations'],
        expectSwAt: fixture.url,
      });
      const swr = result.scenarios.find((s) => s.id === 'swr');
      const upd = result.scenarios.find((s) => s.id === 'sw-update');
      assert.ok(swr);
      assert.ok(upd);
      assert.equal(swr.status, 'na');
      assert.equal(upd.status, 'na');
      assert.equal(result.serviceWorkerDetected, false);
    } finally {
      await page.close();
      await fixture.close();
    }
  });

  test('skipScenarios removes every skipped scenario from execution', async () => {
    const fixture = await simpleHtmlFixture('<html><body>ok</body></html>');
    const page = await newPage();
    try {
      await page.goto(fixture.url);
      const result = await runOfflineAudit(page, {
        skipScenarios: [
          'full-offline',
          'slow-3g',
          'intermittent',
          'offline-mutations',
          'swr',
          'sw-update',
        ],
        expectSwAt: fixture.url,
      });
      assert.equal(result.scenarios.length, 6);
      for (const s of result.scenarios) {
        assert.equal(s.status, 'skipped', `${s.id} should be skipped`);
      }
      assert.equal(result.issues.length, 0);
      assert.equal(result.passed, true, 'an all-skipped run should pass (no issues)');
    } finally {
      await page.close();
      await fixture.close();
    }
  });

  test('restores online state after scenarios run', async () => {
    const fixture = await simpleHtmlFixture('<html><body>ok</body></html>');
    const page = await newPage();
    try {
      await page.goto(fixture.url);
      await runOfflineAudit(page, {
        skipScenarios: ['slow-3g', 'swr', 'sw-update'],
        expectSwAt: fixture.url,
        navigationTimeoutMs: 4000,
      });
      // After the audit, we must be back online — a real fetch should succeed.
      const resp = await page.request.get(fixture.url);
      assert.ok(resp.ok(), 'network must be restored to online after the audit');
    } finally {
      await page.close();
      await fixture.close();
    }
  });

  test('preloadRoutes warms up routes before offline testing', async () => {
    let requestCount = 0;
    const server = await startFixture((req, res) => {
      requestCount++;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>' + (req.url ?? '') + '</body></html>');
    });
    const page = await newPage();
    try {
      await page.goto(server.url);
      const baseBefore = requestCount;
      await runOfflineAudit(page, {
        preloadRoutes: [server.url + '/a', server.url + '/b'],
        skipScenarios: [
          'full-offline',
          'slow-3g',
          'intermittent',
          'offline-mutations',
          'swr',
          'sw-update',
        ],
        expectSwAt: server.url,
      });
      // preloadRoutes should have triggered at least two additional navigations
      assert.ok(requestCount >= baseBefore + 2, `expected preload navigations; saw ${requestCount}`);
    } finally {
      await page.close();
      await server.close();
    }
  });

  test('result shape includes startedAt/finishedAt/durationMs and page url', async () => {
    const fixture = await simpleHtmlFixture('<html><body>ok</body></html>');
    const page = await newPage();
    try {
      await page.goto(fixture.url);
      const result = await runOfflineAudit(page, {
        skipScenarios: [
          'full-offline',
          'slow-3g',
          'intermittent',
          'offline-mutations',
          'swr',
          'sw-update',
        ],
        expectSwAt: fixture.url,
      });
      assert.equal(typeof result.page, 'string');
      assert.match(result.startedAt, /\d{4}-\d{2}-\d{2}T/);
      assert.match(result.finishedAt, /\d{4}-\d{2}-\d{2}T/);
      assert.ok(result.durationMs >= 0);
      assert.ok(Array.isArray(result.scenarios));
      assert.ok(Array.isArray(result.issues));
      assert.equal(typeof result.passed, 'boolean');
      assert.equal(typeof result.serviceWorkerDetected, 'boolean');
    } finally {
      await page.close();
      await fixture.close();
    }
  });
});
