import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { auditAuthEdge } from './auth-edge-audit.js';

let browser: Browser | undefined;
let context: BrowserContext | undefined;
let tmpDir = '';

interface TestServerHandles {
  server: http.Server;
  url: string;
  close: () => Promise<void>;
}

function startServer(handler: http.RequestListener): Promise<TestServerHandles> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({
        server,
        url,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

async function makeStorageState(dir: string, origin: string, cookieName: string, cookieValue: string): Promise<string> {
  const state = {
    cookies: [
      {
        name: cookieName,
        value: cookieValue,
        domain: new URL(origin).hostname,
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 3600,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax' as const,
      },
    ],
    origins: [],
  };
  const filePath = path.join(dir, 'storage-state.json');
  await writeFile(filePath, JSON.stringify(state), 'utf8');
  return filePath;
}

before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  tmpDir = await mkdtemp(path.join(tmpdir(), 'uxinspect-authedge-'));
});

after(async () => {
  await context?.close();
  await browser?.close();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

async function newPage(): Promise<Page> {
  if (!browser) throw new Error('browser not ready');
  const ctx = await browser.newContext();
  return ctx.newPage();
}

describe('auditAuthEdge', () => {
  test('flags tokenExpiry when protected URL still grants access after cookie expiry', async () => {
    const handler: http.RequestListener = (req, res) => {
      // Broken backend: grants access regardless of cookie
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html');
      res.end('<html><body><h1>Dashboard</h1></body></html>');
    };
    const srv = await startServer(handler);
    try {
      const storagePath = await makeStorageState(tmpDir, srv.url, 'sessionid', 'abc123');
      const page = await newPage();
      try {
        const result = await auditAuthEdge(page, {
          storageStatePath: storagePath,
          loginUrl: `${srv.url}/login`,
          protectedUrl: `${srv.url}/dashboard`,
        });
        assert.equal(result.tokenExpiry, 'broken', 'expired cookies should not grant access');
        assert.equal(result.passed, false);
        assert.ok(
          result.evidence.some((e) => e.scenario === 'tokenExpiry' && e.severity === 'fail'),
          'should include a fail evidence entry for tokenExpiry',
        );
      } finally {
        await page.context().close();
      }
    } finally {
      await srv.close();
    }
  });

  test('passes logoutCleanup when server redirects unauthenticated users to login', async () => {
    // Simple backend that gates /dashboard on a session cookie
    const handler: http.RequestListener = (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const cookieHeader = req.headers.cookie ?? '';
      const hasSession = /sessionid=[a-zA-Z0-9]+/.test(cookieHeader) && !cookieHeader.includes('sessionid=;');
      if (url.pathname === '/logout') {
        res.setHeader('set-cookie', 'sessionid=; Path=/; Max-Age=0; HttpOnly');
        res.statusCode = 200;
        res.end('<html><body>logged out</body></html>');
        return;
      }
      if (url.pathname === '/dashboard') {
        if (hasSession) {
          res.statusCode = 200;
          res.end('<html><body><h1>Dashboard</h1></body></html>');
        } else {
          res.statusCode = 302;
          res.setHeader('location', '/login');
          res.end();
        }
        return;
      }
      if (url.pathname === '/login') {
        res.statusCode = 200;
        res.end('<html><body>login page</body></html>');
        return;
      }
      res.statusCode = 404;
      res.end();
    };
    const srv = await startServer(handler);
    try {
      const storagePath = await makeStorageState(tmpDir, srv.url, 'sessionid', 'validtoken');
      const page = await newPage();
      try {
        const result = await auditAuthEdge(page, {
          storageStatePath: storagePath,
          loginUrl: `${srv.url}/login`,
          protectedUrl: `${srv.url}/dashboard`,
          logoutUrl: `${srv.url}/logout`,
        });
        // Token expiry: expired cookies -> 302 to /login = ok
        assert.equal(result.tokenExpiry, 'ok');
        // Logout cleanup: after logout, /dashboard redirects to login = ok
        assert.equal(result.logoutCleanup, 'ok');
        // Session fixation: no loginCredentials -> skipped
        assert.equal(result.sessionFixation, 'skipped');
        // CSRF: no selector -> skipped
        assert.equal(result.csrf, 'skipped');
        // No broken/stale/fixed/static states
        assert.ok(result.passed, 'expected overall pass when no broken states detected');
      } finally {
        await page.context().close();
      }
    } finally {
      await srv.close();
    }
  });

  test('returns a well-shaped result object with evidence array', async () => {
    const handler: http.RequestListener = (_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', '/login');
      res.end();
    };
    const srv = await startServer(handler);
    try {
      const storagePath = await makeStorageState(tmpDir, srv.url, 'sessionid', 'tok');
      const page = await newPage();
      try {
        const result = await auditAuthEdge(page, {
          storageStatePath: storagePath,
          loginUrl: `${srv.url}/login`,
          protectedUrl: `${srv.url}/protected`,
        });
        assert.equal(typeof result.tokenExpiry, 'string');
        assert.equal(typeof result.refresh, 'string');
        assert.equal(typeof result.logoutCleanup, 'string');
        assert.equal(typeof result.sessionFixation, 'string');
        assert.equal(typeof result.csrf, 'string');
        assert.ok(Array.isArray(result.evidence));
        assert.equal(typeof result.passed, 'boolean');
      } finally {
        await page.context().close();
      }
    } finally {
      await srv.close();
    }
  });
});
