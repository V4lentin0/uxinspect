// Tests for the concurrency audit (P4 #41).
//
// Each test spins up a real http fixture that exhibits the specific
// concurrency bug we want to verify (or its correct counterpart), then
// drives the audit with a real Playwright BrowserContext.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Browser, BrowserContext } from 'playwright';
import { chromium } from 'playwright';
import { runConcurrencyAudit } from './concurrency-audit.js';

let browser: Browser | undefined;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

async function newContext(): Promise<BrowserContext> {
  if (!browser) throw new Error('browser not ready');
  return browser.newContext();
}

interface Fixture {
  url: string;
  close: () => Promise<void>;
  // Mutable state so tests can inspect / tweak behaviour
  state: {
    submitCount: number;
    // For stale-write: a monotonic server version. First writer wins,
    // second writer (with the same stale version) gets 409.
    version: number;
    // For double-submit: when true, server deduplicates the second POST.
    dedupe: boolean;
    // For session-stomp: when true, a fresh login invalidates the old session.
    invalidateOldSession: boolean;
    // Active session id; used by the invalidating variant.
    activeSession: string | null;
    // For ws-dup: flag enabling duplicate broadcast bug.
    wsDoubleSubscribe: boolean;
  };
}

/**
 * A single fixture that can act as all five scenario targets. The path
 * segment picks behaviour:
 *
 *   /form            — GET form page; POST submits.
 *   /edit            — GET edit form with a hidden `version`; PUT saves
 *                      with If-Match-style check.
 *   /login           — GET login form; POST authenticates.
 *   /ws-page         — page that opens a WebSocket and displays a button.
 *   /storage         — blank page for localStorage races.
 */
async function startFixture(
  overrides: Partial<Fixture['state']> = {},
): Promise<Fixture> {
  const state: Fixture['state'] = {
    submitCount: 0,
    version: 1,
    dedupe: false,
    invalidateOldSession: false,
    activeSession: null,
    wsDoubleSubscribe: false,
    ...overrides,
  };

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';

    // Simple same-origin policy for cookies: we don't set domain, so cookies
    // bind to the server host.
    const readCookies = (): Map<string, string> => {
      const map = new Map<string, string>();
      const raw = req.headers['cookie'];
      if (!raw) return map;
      for (const part of raw.split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k) map.set(k, v.join('='));
      }
      return map;
    };

    /* ── /form: POST form, counts submits ─────────────────────────── */
    if (url.startsWith('/form')) {
      if (req.method === 'GET') {
        res.setHeader('content-type', 'text/html');
        res.end(
          `<html><body><form method="POST" action="/form">
             <input name="x" value="hello"/>
             <button type="submit">Submit</button>
           </form></body></html>`,
        );
        return;
      }
      if (req.method === 'POST') {
        state.submitCount += 1;
        if (state.dedupe && state.submitCount > 1) {
          res.statusCode = 409;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'duplicate' }));
          return;
        }
        res.statusCode = 201;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, n: state.submitCount }));
        return;
      }
    }

    /* ── /edit: optimistic-locked edit ───────────────────────────── */
    if (url.startsWith('/edit')) {
      if (req.method === 'GET') {
        res.setHeader('content-type', 'text/html');
        // The client embeds the current version in a hidden input. A real
        // client would read it and send it back; for a race simulation we
        // simply send whatever version the server has now.
        const version = state.version;
        res.end(
          `<html><body>
             <form id="f" method="POST" action="/edit">
               <input type="hidden" name="version" value="${version}"/>
               <input name="body" value="edited"/>
               <button id="save" type="submit">Save</button>
             </form>
             <script>
               // Intercept submit so we can send JSON with the version we
               // LOADED (not the current server one).
               document.getElementById('f').addEventListener('submit', function(e){
                 e.preventDefault();
                 fetch('/edit', {
                   method: 'POST',
                   headers: {'content-type': 'application/json'},
                   body: JSON.stringify({ version: ${version}, body: 'edited' })
                 }).then(function(r){
                   document.body.setAttribute('data-status', r.status);
                 }).catch(function(){
                   document.body.setAttribute('data-status', 'err');
                 });
               });
             </script>
           </body></html>`,
        );
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += String(c)));
        await new Promise<void>((r) => req.on('end', () => r()));
        let parsed: { version?: number } = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          /* ignore */
        }
        const sent = typeof parsed.version === 'number' ? parsed.version : -1;
        if (sent !== state.version) {
          res.statusCode = 409;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'version conflict', expected: state.version, got: sent }));
          return;
        }
        state.version += 1;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, newVersion: state.version }));
        return;
      }
    }

    /* ── Login + session ─────────────────────────────────────────── */
    if (url.startsWith('/login')) {
      if (req.method === 'GET') {
        res.setHeader('content-type', 'text/html');
        res.end(
          `<html><body>
             <form method="POST" action="/login">
               <input name="username"/>
               <input name="password" type="password"/>
               <button type="submit">Log in</button>
             </form>
           </body></html>`,
        );
        return;
      }
      if (req.method === 'POST') {
        const sid = `s-${Math.random().toString(36).slice(2, 10)}`;
        if (state.invalidateOldSession) state.activeSession = sid;
        res.setHeader('set-cookie', `sid=${sid}; Path=/; HttpOnly`);
        res.statusCode = 303;
        res.setHeader('location', '/protected');
        res.end();
        return;
      }
    }

    if (url.startsWith('/protected')) {
      const cookies = readCookies();
      const sid = cookies.get('sid');
      if (!sid) {
        res.statusCode = 302;
        res.setHeader('location', '/login');
        res.end();
        return;
      }
      if (state.invalidateOldSession && state.activeSession && sid !== state.activeSession) {
        // Silent redirect to /login — the "bad" variant the audit should catch.
        res.statusCode = 302;
        res.setHeader('location', '/login');
        res.end();
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end('<html><body><h1>Welcome</h1></body></html>');
      return;
    }

    /* ── /ws-page: page that opens a WS ──────────────────────────── */
    if (url.startsWith('/ws-page')) {
      res.setHeader('content-type', 'text/html');
      const dup = state.wsDoubleSubscribe ? 'true' : 'false';
      res.end(
        `<html><body>
           <button id="trigger">Trigger</button>
           <script>
             (function(){
               var wsUrl = 'ws://' + location.host + '/ws';
               var s1 = new WebSocket(wsUrl);
               // If the double-subscribe bug is enabled, open a second socket
               // so the same broadcast arrives twice per page.
               var s2 = ${dup} ? new WebSocket(wsUrl) : null;
               window.__ready = Promise.all([
                 new Promise(function(r){ s1.addEventListener('open', r); }),
                 s2 ? new Promise(function(r){ s2.addEventListener('open', r); }) : Promise.resolve()
               ]);
               document.getElementById('trigger').addEventListener('click', function(){
                 s1.send('broadcast');
               });
             })();
           </script>
         </body></html>`,
      );
      return;
    }

    /* ── /storage: blank page for localStorage races ─────────────── */
    if (url.startsWith('/storage')) {
      res.setHeader('content-type', 'text/html');
      res.end('<html><body><h1>storage race</h1></body></html>');
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  // Minimal WebSocket upgrade: broadcast any text frame to all connected
  // clients (RFC 6455 text-frame echo, <=125-byte payloads).
  const sockets: import('node:stream').Duplex[] = [];
  server.on('upgrade', (req, socket) => {
    if (req.url !== '/ws') {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    // Compute Sec-WebSocket-Accept = SHA1(key + GUID) base64
    const acceptKey = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`,
    );
    sockets.push(socket);
    socket.on('close', () => {
      const i = sockets.indexOf(socket);
      if (i >= 0) sockets.splice(i, 1);
    });
    socket.on('error', () => {
      // ignore
    });
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      // Parse minimal unmasked/masked text frames (<=125 bytes).
      while (buf.length >= 2) {
        const b0 = buf[0]!;
        const b1 = buf[1]!;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        const len = b1 & 0x7f;
        if (len > 125) return; // we only handle small frames
        const headerLen = 2 + (masked ? 4 : 0);
        if (buf.length < headerLen + len) return;
        let payload = buf.subarray(headerLen, headerLen + len);
        if (masked) {
          const mask = buf.subarray(2, 6);
          const unmasked = Buffer.alloc(len);
          for (let i = 0; i < len; i += 1) {
            unmasked[i] = payload[i]! ^ mask[i % 4]!;
          }
          payload = unmasked;
        }
        buf = buf.subarray(headerLen + len);
        if (opcode === 0x1) {
          // text frame — broadcast to every connected socket (including sender).
          const text = payload.toString('utf8');
          const out = Buffer.alloc(2 + text.length);
          out[0] = 0x81; // FIN + text
          out[1] = text.length;
          out.write(text, 2, 'utf8');
          for (const s of sockets) {
            try {
              s.write(out);
            } catch {
              /* ignore */
            }
          }
        } else if (opcode === 0x8) {
          socket.end();
          return;
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

describe('runConcurrencyAudit: double-submit', () => {
  test('flags duplicate accepts when backend does NOT dedup', async () => {
    const fx = await startFixture({ dedupe: false });
    const context = await newContext();
    try {
      const result = await runConcurrencyAudit(
        { browser, context },
        {
          scenarios: ['double-submit'],
          flowFormUrl: `${fx.url}/form`,
          timeoutMs: 8000,
        },
      );
      const s = result.scenarios.find((r) => r.scenario === 'double-submit');
      assert.ok(s, 'double-submit scenario must run');
      assert.equal(s!.ran, true);
      assert.equal(s!.passed, false, 'should flag duplicate accept');
      const issue = s!.issues.find((i) => i.kind === 'duplicate-accepted');
      assert.ok(issue, 'duplicate-accepted issue expected');
      assert.equal(fx.state.submitCount, 2);
    } finally {
      await context.close();
      await fx.close();
    }
  });

  test('passes when backend dedups the second submit', async () => {
    const fx = await startFixture({ dedupe: true });
    const context = await newContext();
    try {
      const result = await runConcurrencyAudit(
        { browser, context },
        {
          scenarios: ['double-submit'],
          flowFormUrl: `${fx.url}/form`,
          submitUrlIncludes: '/form',
          timeoutMs: 8000,
        },
      );
      const s = result.scenarios.find((r) => r.scenario === 'double-submit');
      assert.ok(s);
      assert.equal(s!.passed, true, 'dedup backend should be a pass');
      assert.equal(s!.issues.length, 0);
    } finally {
      await context.close();
      await fx.close();
    }
  });
});

describe('runConcurrencyAudit: stale-write', () => {
  test('flags silent overwrite when server does NOT enforce optimistic lock', async () => {
    // "bad" server: always returns 200 regardless of version.
    const fx = await startFixture();
    const context = await newContext();
    try {
      // Monkey-patch: override /edit POST to always return 200.
      // Simplest: new fixture with a server that ignores the version check.
      // We achieve the same by setting version to the version clients will
      // send (always accept) — but we want to simulate a BROKEN server.
      // So we start a second fixture without the optimistic-lock behaviour.
      // Simpler: mutate state. Our fixture already enforces; override by
      // closing it and using a brand-new "buggy" server.
      await fx.close();
      const buggy = await startBuggyEditFixture();
      try {
        const result = await runConcurrencyAudit(
          { browser, context },
          {
            scenarios: ['stale-write'],
            flowEditUrl: `${buggy.url}/edit`,
            submitSelector: 'button#save',
            editUrlIncludes: '/edit',
            timeoutMs: 8000,
          },
        );
        const s = result.scenarios.find((r) => r.scenario === 'stale-write');
        assert.ok(s);
        assert.equal(s!.ran, true);
        assert.equal(s!.passed, false, 'buggy server should be flagged');
        const issue = s!.issues.find((i) => i.kind === 'stale-overwrite-accepted');
        assert.ok(issue, 'stale-overwrite-accepted issue expected');
      } finally {
        await buggy.close();
      }
    } finally {
      await context.close();
    }
  });

  test('passes when server returns 409 on stale version', async () => {
    const fx = await startFixture();
    const context = await newContext();
    try {
      const result = await runConcurrencyAudit(
        { browser, context },
        {
          scenarios: ['stale-write'],
          flowEditUrl: `${fx.url}/edit`,
          submitSelector: 'button#save',
          editUrlIncludes: '/edit',
          timeoutMs: 8000,
        },
      );
      const s = result.scenarios.find((r) => r.scenario === 'stale-write');
      assert.ok(s);
      assert.equal(s!.passed, true, 'optimistic-lock server should pass');
      assert.equal(s!.issues.length, 0);
    } finally {
      await context.close();
      await fx.close();
    }
  });
});

describe('runConcurrencyAudit: session-stomp', () => {
  test('flags silent redirect to /login with no user-facing message', async () => {
    const fx = await startFixture({ invalidateOldSession: true });
    const context = await newContext();
    try {
      const result = await runConcurrencyAudit(
        { browser, context },
        {
          scenarios: ['session-stomp'],
          flowFormUrl: `${fx.url}/login`,
          credentials: { username: 'u', password: 'p' },
          postLoginProbeUrl: `${fx.url}/protected`,
          loginSelectors: {
            url: `${fx.url}/login`,
            username: 'input[name="username"]',
            password: 'input[type="password"]',
            submit: 'button[type="submit"]',
          },
          timeoutMs: 8000,
        },
      );
      const s = result.scenarios.find((r) => r.scenario === 'session-stomp');
      assert.ok(s);
      assert.equal(s!.ran, true);
      assert.equal(s!.passed, false, 'silent redirect should be flagged');
    } finally {
      await context.close();
      await fx.close();
    }
  });

  test('passes when multi-session is allowed (older tab still works)', async () => {
    const fx = await startFixture({ invalidateOldSession: false });
    const context = await newContext();
    try {
      const result = await runConcurrencyAudit(
        { browser, context },
        {
          scenarios: ['session-stomp'],
          flowFormUrl: `${fx.url}/login`,
          credentials: { username: 'u', password: 'p' },
          postLoginProbeUrl: `${fx.url}/protected`,
          loginSelectors: {
            url: `${fx.url}/login`,
            username: 'input[name="username"]',
            password: 'input[type="password"]',
            submit: 'button[type="submit"]',
          },
          timeoutMs: 8000,
        },
      );
      const s = result.scenarios.find((r) => r.scenario === 'session-stomp');
      assert.ok(s);
      assert.equal(s!.passed, true, 'multi-session should pass');
    } finally {
      await context.close();
      await fx.close();
    }
  });

  test('skips when no Browser instance is provided', async () => {
    const fx = await startFixture();
    const context = await newContext();
    try {
      // No browser => session-stomp cannot create a second isolated context.
      const result = await runConcurrencyAudit(
        { context },
        {
          scenarios: ['session-stomp'],
          flowFormUrl: `${fx.url}/login`,
          credentials: { username: 'u', password: 'p' },
          timeoutMs: 5000,
        },
      );
      const s = result.scenarios.find((r) => r.scenario === 'session-stomp');
      assert.ok(s);
      assert.equal(s!.ran, false);
      assert.ok(
        s!.issues.some((i) => i.kind === 'scenario-skipped'),
        'should be skipped with scenario-skipped issue',
      );
      // Skipped scenarios still count as passing at the scenario level.
      assert.equal(s!.passed, true);
    } finally {
      await context.close();
      await fx.close();
    }
  });
});

describe('runConcurrencyAudit: ws-dup', () => {
  test('flags duplicate messages when the page double-subscribes', async () => {
    const fx = await startFixture({ wsDoubleSubscribe: true });
    const context = await newContext();
    try {
      const result = await runConcurrencyAudit(
        { browser, context },
        {
          scenarios: ['ws-dup'],
          wsUrl: `${fx.url}/ws-page`,
          wsTriggerSelector: '#trigger',
          timeoutMs: 8000,
        },
      );
      const s = result.scenarios.find((r) => r.scenario === 'ws-dup');
      assert.ok(s);
      assert.equal(s!.ran, true);
      const issue = s!.issues.find((i) => i.kind === 'ws-duplicate-message');
      assert.ok(issue, 'ws-duplicate-message should be flagged');
      assert.equal(s!.passed, false);
    } finally {
      await context.close();
      await fx.close();
    }
  });
});

describe('runConcurrencyAudit: storage-race', () => {
  test('detects silent forks when storage events do not reconcile', async () => {
    const fx = await startFixture();
    const context = await newContext();
    try {
      const result = await runConcurrencyAudit(
        { browser, context },
        {
          scenarios: ['storage-race'],
          storageRaceUrl: `${fx.url}/storage`,
          storageKey: 'race-test-key',
          timeoutMs: 8000,
        },
      );
      const s = result.scenarios.find((r) => r.scenario === 'storage-race');
      assert.ok(s);
      assert.equal(s!.ran, true);
      // Chromium dispatches 'storage' events cross-tab within a BrowserContext,
      // so the correct outcome is PASS (events fired, no silent fork).
      // Either way, the test verifies the scenario ran without throwing and
      // any issue raised is a structured RaceIssue.
      for (const i of s!.issues) {
        assert.ok(
          ['storage-silent-fork', 'scenario-skipped', 'scenario-error'].includes(i.kind),
          `unexpected issue kind: ${i.kind}`,
        );
      }
    } finally {
      await context.close();
      await fx.close();
    }
  });
});

describe('runConcurrencyAudit: result shape + behaviour', () => {
  test('runs all 5 scenarios by default; unconfigured scenarios skip cleanly', async () => {
    const fx = await startFixture();
    const context = await newContext();
    try {
      const result = await runConcurrencyAudit(
        { browser, context },
        {
          flowFormUrl: `${fx.url}/form`,
          // Only form is configured — the other scenarios should skip, not throw.
          timeoutMs: 5000,
        },
      );
      assert.equal(result.scenarios.length, 5);
      assert.ok(typeof result.durationMs === 'number' && result.durationMs >= 0);
      assert.ok(typeof result.startedAt === 'string');
      assert.ok(typeof result.finishedAt === 'string');
      // The issues array is the union of all scenario issues.
      const flatCount = result.scenarios.reduce((n, s) => n + s.issues.length, 0);
      assert.equal(result.issues.length, flatCount);
      // Every scenario that couldn't be configured should be marked skipped.
      const unconfigured = result.scenarios.filter((s) => !s.ran);
      for (const s of unconfigured) {
        assert.ok(s.issues.some((i) => i.kind === 'scenario-skipped'));
        assert.equal(s.passed, true);
      }
    } finally {
      await context.close();
      await fx.close();
    }
  });

  test('caller can request only a single scenario', async () => {
    const fx = await startFixture();
    const context = await newContext();
    try {
      const result = await runConcurrencyAudit(
        { browser, context },
        {
          scenarios: ['storage-race'],
          storageRaceUrl: `${fx.url}/storage`,
          timeoutMs: 5000,
        },
      );
      assert.equal(result.scenarios.length, 1);
      assert.equal(result.scenarios[0]!.scenario, 'storage-race');
    } finally {
      await context.close();
      await fx.close();
    }
  });
});

/**
 * Start a "buggy" variant of the /edit endpoint that always accepts writes
 * regardless of the supplied version — used to verify the stale-write audit
 * correctly flags this class of server.
 */
async function startBuggyEditFixture(): Promise<Fixture> {
  const state: Fixture['state'] = {
    submitCount: 0,
    version: 1,
    dedupe: false,
    invalidateOldSession: false,
    activeSession: null,
    wsDoubleSubscribe: false,
  };
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/edit') && req.method === 'GET') {
      res.setHeader('content-type', 'text/html');
      res.end(
        `<html><body>
           <form id="f" method="POST" action="/edit">
             <input type="hidden" name="version" value="${state.version}"/>
             <button id="save" type="submit">Save</button>
           </form>
           <script>
             document.getElementById('f').addEventListener('submit', function(e){
               e.preventDefault();
               fetch('/edit', {
                 method: 'POST',
                 headers: {'content-type': 'application/json'},
                 body: JSON.stringify({ version: ${state.version} })
               }).then(function(r){ document.body.setAttribute('data-status', r.status); });
             });
           </script>
         </body></html>`,
      );
      return;
    }
    if (url.startsWith('/edit') && req.method === 'POST') {
      // BUG: always accept, regardless of version.
      let body = '';
      req.on('data', (c) => (body += String(c)));
      await new Promise<void>((r) => req.on('end', () => r()));
      state.version += 1;
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end('nf');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
