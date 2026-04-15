import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { auditGdprConsent } from './gdpr-audit.js';

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
  await context.clearCookies();
  return context.newPage();
}

interface MiniServer {
  url: string;
  close: () => Promise<void>;
}

async function startServer(handler: http.RequestListener): Promise<MiniServer> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

describe('auditGdprConsent', () => {
  test('non-essential tracking cookie set before consent is flagged', async () => {
    // Server sets Google Analytics _ga cookie before any user interaction
    const server = await startServer((_req, res) => {
      res.setHeader('Set-Cookie', [
        '_ga=GA1.2.12345.67890; Path=/; Max-Age=63072000',
        'PHPSESSID=abc123; Path=/',
      ]);
      res.setHeader('Content-Type', 'text/html');
      res.end(`
        <html><body>
          <div id="banner">
            We use cookies.
            <button type="button" id="accept">Accept all</button>
            <button type="button" id="reject">Reject all</button>
          </div>
          <h1>page</h1>
        </body></html>
      `);
    });

    const page = await newPage();
    try {
      await page.goto(server.url, { waitUntil: 'networkidle' });
      const result = await auditGdprConsent(page);

      assert.equal(typeof result.page, 'string');
      assert.ok(Array.isArray(result.preconsentCookies));
      assert.ok(Array.isArray(result.acceptedCookies));
      assert.ok(Array.isArray(result.rejectedButSetCookies));
      assert.ok(Array.isArray(result.undeclaredCookies));
      assert.ok(Array.isArray(result.issues));

      // _ga should be present in preconsent cookies and classified as tracker
      const ga = result.preconsentCookies.find((c) => c.name === '_ga');
      assert.ok(ga, 'expected _ga cookie to be captured preconsent');
      assert.equal(ga.essential, false);
      assert.equal(ga.tracker, 'google-analytics');

      // PHPSESSID should be essential (not flagged)
      const session = result.preconsentCookies.find((c) => c.name === 'PHPSESSID');
      assert.ok(session, 'expected PHPSESSID cookie to be captured');
      assert.equal(session.essential, true);

      // issues must include tracking-before-consent for _ga
      const preIssue = result.issues.find(
        (i) => i.phase === 'preconsent' && i.kind === 'tracking-before-consent' && i.cookie === '_ga',
      );
      assert.ok(preIssue, 'expected a tracking-before-consent issue for _ga');

      // Overall must fail
      assert.equal(result.passed, false);
    } finally {
      await page.close();
      await server.close();
    }
  });

  test('page that respects reject and sets no trackers passes', async () => {
    // Server sets a tracker only if accept-cookie is present, nothing otherwise.
    const server = await startServer((req, res) => {
      const cookieHeader = req.headers.cookie ?? '';
      const accepted = /consent=accepted/.test(cookieHeader);
      const setCookie: string[] = [];
      if (accepted) {
        setCookie.push('_ga=GA1.2.99.99; Path=/; Max-Age=63072000');
      }
      setCookie.push('PHPSESSID=sess1; Path=/');
      res.setHeader('Set-Cookie', setCookie);
      res.setHeader('Content-Type', 'text/html');
      res.end(`
        <html><body>
          <div id="banner">
            <button type="button" id="accept"
              onclick="document.cookie='consent=accepted;path=/';location.reload();">Accept all</button>
            <button type="button" id="reject"
              onclick="document.cookie='consent=rejected;path=/';location.reload();">Reject all</button>
          </div>
          <h1>compliant</h1>
        </body></html>
      `);
    });

    const page = await newPage();
    try {
      await page.goto(server.url, { waitUntil: 'networkidle' });
      const result = await auditGdprConsent(page);

      // No tracker should remain after reject
      assert.deepEqual(
        result.rejectedButSetCookies.map((c) => c.name),
        [],
        `expected no tracker cookies after reject but got: ${JSON.stringify(result.rejectedButSetCookies.map((c) => c.name))}`,
      );

      // No preconsent tracking issue, no tracker-set-after-reject issue
      const rejectIssue = result.issues.find((i) => i.kind === 'tracker-set-after-reject');
      assert.equal(rejectIssue, undefined);

      const preTrackerIssue = result.issues.find((i) => i.kind === 'tracking-before-consent');
      assert.equal(preTrackerIssue, undefined, 'no preconsent tracker should be flagged on compliant site');

      // Banner should have been detected (accept and/or reject click fired)
      assert.equal(result.bannerDetected, true);

      // passed = true (no issues)
      assert.equal(result.passed, true);
    } finally {
      await page.close();
      await server.close();
    }
  });

  test('rejected-but-still-set tracker cookie is flagged as violation', async () => {
    // Always-bad site: sets _ga no matter what, even on reject
    const server = await startServer((_req, res) => {
      res.setHeader('Set-Cookie', [
        '_fbp=fb.1.111.222; Path=/; Max-Age=7776000',
      ]);
      res.setHeader('Content-Type', 'text/html');
      res.end(`
        <html><body>
          <div id="banner">
            <button type="button" id="accept">Accept all</button>
            <button type="button" id="reject">Reject all</button>
          </div>
        </body></html>
      `);
    });

    const page = await newPage();
    try {
      await page.goto(server.url, { waitUntil: 'networkidle' });
      const result = await auditGdprConsent(page);

      // _fbp is a facebook tracker and will be present after reject too
      assert.ok(
        result.rejectedButSetCookies.some((c) => c.name === '_fbp'),
        'expected _fbp tracker cookie to still be set after reject',
      );

      const rejIssue = result.issues.find(
        (i) => i.kind === 'tracker-set-after-reject' && i.cookie === '_fbp',
      );
      assert.ok(rejIssue, 'expected tracker-set-after-reject issue for _fbp');

      assert.equal(result.passed, false);
    } finally {
      await page.close();
      await server.close();
    }
  });

  test('declaration url with _ga not listed flags undeclared-cookie', async () => {
    // Page sets _ga after accept; declaration only lists PHPSESSID
    const siteServer = await startServer((_req, res) => {
      res.setHeader('Set-Cookie', [
        'PHPSESSID=s1; Path=/',
        '_ga=GA1.2.111.222; Path=/; Max-Age=63072000',
      ]);
      res.setHeader('Content-Type', 'text/html');
      res.end(`
        <html><body>
          <button id="accept">Accept all</button>
        </body></html>
      `);
    });
    const declServer = await startServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ cookies: [{ name: 'PHPSESSID' }] }));
    });

    const page = await newPage();
    try {
      await page.goto(siteServer.url, { waitUntil: 'networkidle' });
      const result = await auditGdprConsent(page, {
        consentDeclarationUrl: declServer.url,
      });

      assert.deepEqual(result.declaredCookieNames, ['PHPSESSID']);
      assert.ok(
        result.undeclaredCookies.some((c) => c.name === '_ga'),
        'expected _ga to be marked undeclared',
      );
      const undeclaredIssue = result.issues.find(
        (i) => i.kind === 'undeclared-cookie' && i.cookie === '_ga',
      );
      assert.ok(undeclaredIssue);
      assert.equal(result.passed, false);
    } finally {
      await page.close();
      await siteServer.close();
      await declServer.close();
    }
  });
});
