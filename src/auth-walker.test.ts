import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { walkAuthGatedRoutes, resolveRoutes } from './auth-walker.js';

interface Server {
  server: http.Server;
  port: number;
  hits: Map<string, number>;
  close: () => Promise<void>;
}

async function startFixtureServer(): Promise<Server> {
  const hits = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    hits.set(url, (hits.get(url) ?? 0) + 1);

    // sitemap.xml and robots.txt are publicly accessible (no auth required).
    if (url === '/sitemap.xml') {
      const selfPort = (server.address() as { port: number }).port;
      res.setHeader('content-type', 'application/xml');
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>http://127.0.0.1:${selfPort}/a</loc></url>
<url><loc>http://127.0.0.1:${selfPort}/b</loc></url>
<url><loc>http://127.0.0.1:${selfPort}/c</loc></url>
</urlset>`,
      );
      return;
    }

    // Simulate auth gate on all other routes.
    const cookie = req.headers['cookie'] ?? '';
    const authed = /session=ok/.test(cookie);

    if (!authed) {
      res.statusCode = 401;
      res.setHeader('content-type', 'text/html');
      res.end('<html><body><h1>Login required</h1></body></html>');
      return;
    }

    if (url === '/broken') {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/html');
      res.end('<html><body><h1>Server error</h1></body></html>');
      return;
    }

    if (url === '/with-error-toast') {
      res.setHeader('content-type', 'text/html');
      res.end(
        '<html><body><h1>With error state</h1><div role="alert">Something went wrong</div><button>Retry</button></body></html>',
      );
      return;
    }

    res.setHeader('content-type', 'text/html');
    res.end(
      `<html><body><h1>Page ${url}</h1><a href="#x">link</a><button>Click</button></body></html>`,
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    port,
    hits,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function writeStorageState(port: number): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-authwalker-'));
  const statePath = path.join(dir, 'storage.json');
  const state = {
    cookies: [
      {
        name: 'session',
        value: 'ok',
        domain: '127.0.0.1',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: 'Lax' as const,
      },
    ],
    origins: [],
  };
  await fs.writeFile(statePath, JSON.stringify(state));
  return statePath;
}

let fixture: Server;
let storagePath: string;
let baseUrl: string;

before(async () => {
  fixture = await startFixtureServer();
  storagePath = await writeStorageState(fixture.port);
  baseUrl = `http://127.0.0.1:${fixture.port}`;
});

after(async () => {
  await fixture?.close();
  if (storagePath) {
    await fs.rm(path.dirname(storagePath), { recursive: true, force: true }).catch(() => {});
  }
});

describe('resolveRoutes', () => {
  test('expands array of paths against baseUrl', async () => {
    const urls = await resolveRoutes(['/a', '/b'], 'http://example.com');
    assert.deepEqual(urls, ['http://example.com/a', 'http://example.com/b']);
  });

  test('reads URLs from a file with one URL per line', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-routes-'));
    const file = path.join(dir, 'routes.txt');
    await fs.writeFile(file, '/one\n# a comment\n\n/two\nhttp://external.com/three\n');
    const urls = await resolveRoutes(file, 'http://example.com');
    assert.deepEqual(urls, [
      'http://example.com/one',
      'http://example.com/two',
      'http://external.com/three',
    ]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('fetches URLs from a sitemap.xml endpoint', async () => {
    const urls = await resolveRoutes(`${baseUrl}/sitemap.xml`, baseUrl);
    assert.equal(urls.length, 3);
    assert.ok(urls[0]!.endsWith('/a'));
  });

  test('dedupes duplicate routes', async () => {
    const urls = await resolveRoutes(['/a', '/a', '/b'], 'http://example.com');
    assert.deepEqual(urls, ['http://example.com/a', 'http://example.com/b']);
  });
});

describe('walkAuthGatedRoutes', () => {
  test('visits all 3 routes with storageState and returns status 200', async () => {
    const result = await walkAuthGatedRoutes({
      storageStatePath: storagePath,
      routes: ['/a', '/b', '/c'],
      baseUrl,
      concurrency: 2,
      explore: false,
    });
    assert.equal(result.visited.length, 3);
    assert.equal(result.failed.length, 0);
    const urls = result.visited.map((v) => new URL(v.url).pathname).sort();
    assert.deepEqual(urls, ['/a', '/b', '/c']);
    for (const v of result.visited) {
      assert.equal(v.status, 200);
      assert.ok(typeof v.durationMs === 'number');
      assert.ok(v.durationMs >= 0);
    }
  });

  test('respects concurrency limit (never exceeds configured value)', async () => {
    // Instrument the server to count simultaneous active requests.
    const active = { cur: 0, peak: 0 };
    const barrier = startInstrumentedServer(active);
    const srv = await barrier.start();
    try {
      const state = await writeStorageState(srv.port);
      const routes = Array.from({ length: 8 }, (_, i) => `/p${i}`);
      const result = await walkAuthGatedRoutes({
        storageStatePath: state,
        routes,
        baseUrl: `http://127.0.0.1:${srv.port}`,
        concurrency: 3,
        explore: false,
      });
      assert.equal(result.visited.length, 8);
      assert.ok(active.peak <= 3, `concurrency breached: peak=${active.peak}`);
      await fs.rm(path.dirname(state), { recursive: true, force: true }).catch(() => {});
    } finally {
      await barrier.close();
    }
  });

  test('captures failure for invalid route', async () => {
    const result = await walkAuthGatedRoutes({
      storageStatePath: storagePath,
      routes: ['http://127.0.0.1:1/does-not-exist'],
      baseUrl,
      concurrency: 1,
      explore: false,
      navigationTimeoutMs: 3_000,
    });
    assert.equal(result.visited.length, 0);
    assert.equal(result.failed.length, 1);
    assert.ok(result.failed[0]!.error.length > 0);
  });

  test('returns empty result when routes list is empty', async () => {
    const result = await walkAuthGatedRoutes({
      storageStatePath: storagePath,
      routes: [],
      baseUrl,
    });
    assert.deepEqual(result, { visited: [], failed: [] });
  });

  test('accepts sitemap.xml URL and visits each entry', async () => {
    const result = await walkAuthGatedRoutes({
      storageStatePath: storagePath,
      routes: `${baseUrl}/sitemap.xml`,
      baseUrl,
      concurrency: 2,
      explore: false,
    });
    assert.equal(result.visited.length, 3);
    assert.equal(result.failed.length, 0);
  });

  test('detects error-state DOM markers on gated route', async () => {
    const result = await walkAuthGatedRoutes({
      storageStatePath: storagePath,
      routes: ['/with-error-toast'],
      baseUrl,
      concurrency: 1,
      explore: false,
      checkErrorStates: true,
    });
    assert.equal(result.visited.length, 1);
    const v = result.visited[0]!;
    assert.ok((v.errorStates ?? []).some((s) => s.startsWith('[role="alert"]')));
  });

  test('invokes custom perRoute callback for each url', async () => {
    const seen: string[] = [];
    const result = await walkAuthGatedRoutes({
      storageStatePath: storagePath,
      routes: ['/a', '/b'],
      baseUrl,
      concurrency: 1,
      perRoute: async (_page, url) => {
        seen.push(url);
      },
    });
    assert.equal(result.visited.length, 2);
    assert.equal(seen.length, 2);
    assert.ok(seen[0]!.endsWith('/a'));
    assert.ok(seen[1]!.endsWith('/b'));
  });

  test('throws when storageStatePath does not exist', async () => {
    await assert.rejects(
      () =>
        walkAuthGatedRoutes({
          storageStatePath: '/tmp/definitely-not-a-real-file-123456.json',
          routes: ['/a'],
          baseUrl,
        }),
      /storageStatePath not found/,
    );
  });
});

// Instrumented server: each in-flight request bumps `active.cur`; we record peak.
function startInstrumentedServer(active: { cur: number; peak: number }): {
  start: () => Promise<{ server: http.Server; port: number }>;
  close: () => Promise<void>;
} {
  let server: http.Server | undefined;
  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const cookie = req.headers['cookie'] ?? '';
    if (!/session=ok/.test(cookie)) {
      res.statusCode = 401;
      res.end('nope');
      return;
    }
    active.cur += 1;
    active.peak = Math.max(active.peak, active.cur);
    // Hold the connection briefly so overlap is observable.
    setTimeout(() => {
      active.cur -= 1;
      res.setHeader('content-type', 'text/html');
      res.end(`<html><body><h1>${req.url}</h1></body></html>`);
    }, 150);
  };
  return {
    start: async () => {
      server = http.createServer(handler);
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      return { server, port };
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
      }),
  };
}
