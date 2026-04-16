import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { chromium, type Browser } from 'playwright';
import { runAuthEdgeAudit, type AuthEdgeConfig } from './auth-edge-audit.js';

/**
 * Fixture: a tiny in-memory app with four "modes" that let each test pick
 * sensible vs. vulnerable behaviour at will. All state is held in maps keyed
 * by a per-request `mode` query parameter which the server reads from the
 * request URL. Tests override behaviour by pointing at routes that carry the
 * right mode.
 */

interface ServerHandle {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
  /** Map<accessToken, { userId, expired, revoked }>. */
  tokens: Map<string, { userId: string; expired: boolean; revoked: boolean }>;
  /** Map<refreshToken, { userId, revoked }>. */
  refreshTokens: Map<string, { userId: string; revoked: boolean }>;
  /** Map<sessionId, { userId, authed, csrf }>. */
  sessions: Map<string, { userId: string; authed: boolean; csrf: string }>;
  /** Flip behaviour per test. */
  behaviour: Behaviour;
}

interface Behaviour {
  /** If true, login does NOT rotate the session id (fixation vuln). */
  allowSessionFixation: boolean;
  /** If true, logout does not clear server-side refresh token (missing revocation). */
  keepRefreshValidAfterLogout: boolean;
  /** If true, gated route silently accepts any token (silent failure). */
  silentFailureOnExpiredToken: boolean;
  /** If true, CSRF token rotates after state-changing action. */
  rotateCsrfOnStateChange: boolean;
  /** If true, accept token reuse from any session (cross-session CSRF hole). */
  csrfReuseAllowed: boolean;
}

function defaultBehaviour(): Behaviour {
  return {
    allowSessionFixation: false,
    keepRefreshValidAfterLogout: false,
    silentFailureOnExpiredToken: false,
    rotateCsrfOnStateChange: true,
    csrfReuseAllowed: false,
  };
}

function setCookie(
  res: http.ServerResponse,
  name: string,
  value: string,
  opts: { httpOnly?: boolean; sameSite?: 'Strict' | 'Lax' | 'None' } = {},
): void {
  const parts = [`${name}=${value}`, 'Path=/'];
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
  const prev = res.getHeader('Set-Cookie');
  const list = Array.isArray(prev) ? [...prev, parts.join('; ')] : [parts.join('; ')];
  if (prev && typeof prev === 'string') list.unshift(prev);
  res.setHeader('Set-Cookie', list);
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const [k, ...rest] = pair.trim().split('=');
    if (!k) continue;
    out[k] = rest.join('=');
  }
  return out;
}

function newToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

async function startServer(initial: Partial<Behaviour> = {}): Promise<ServerHandle> {
  const tokens: ServerHandle['tokens'] = new Map();
  const refreshTokens: ServerHandle['refreshTokens'] = new Map();
  const sessions: ServerHandle['sessions'] = new Map();
  const behaviour = { ...defaultBehaviour(), ...initial };

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    const cookies = parseCookies(req.headers['cookie']);
    const authHeader = (req.headers['authorization'] ?? '').toString();
    const bearer = authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : null;

    // ───────── Login page ─────────
    if (url === '/' || url === '/login') {
      let sid = cookies['sid'];
      if (!sid) {
        sid = newToken();
        sessions.set(sid, { userId: '', authed: false, csrf: newToken() });
        setCookie(res, 'sid', sid, { httpOnly: true });
      } else if (!sessions.has(sid)) {
        sessions.set(sid, { userId: '', authed: false, csrf: newToken() });
      }
      const csrf = sessions.get(sid)!.csrf;
      setCookie(res, 'XSRF-TOKEN', csrf, { httpOnly: false });
      res.setHeader('Content-Type', 'text/html');
      res.end(`<html><head>
<meta name="csrf-token" content="${csrf}" />
</head><body>
<h1>Login</h1>
<form id="f" onsubmit="event.preventDefault();doLogin();">
  <input id="u" value="u1" />
  <input id="p" value="pw" />
  <button type="submit" id="go">Sign in</button>
</form>
<a id="logout" href="#" onclick="doLogout();return false;">Logout</a>
<script>
async function doLogin() {
  const r = await fetch('/api/login', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ u: 'u1', p: 'pw' }) });
  const j = await r.json();
  localStorage.setItem('access_token', j.access_token);
  localStorage.setItem('refresh_token', j.refresh_token);
  document.body.setAttribute('data-authed', '1');
}
async function doLogout() {
  await fetch('/api/logout', { method: 'POST', credentials: 'include' });
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  document.body.setAttribute('data-authed', '0');
}
// Intercept fetch so access-token 401 triggers /api/refresh (real-world SPA behaviour).
const _origFetch = window.fetch.bind(window);
window.fetch = async function patched(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  const at = localStorage.getItem('access_token');
  const rt = localStorage.getItem('refresh_token');
  const nextInit = Object.assign({}, init || {});
  nextInit.headers = Object.assign({}, (init && init.headers) || {});
  if (at && !/\\/api\\/(login|refresh|logout)/.test(url)) {
    nextInit.headers['X-Access-Token'] = at;
  }
  let res = await _origFetch(input, nextInit);
  if ((res.status === 401 || res.status === 302) && rt && !/\\/api\\/(login|refresh|logout)/.test(url)) {
    const rr = await _origFetch('/api/refresh', { method: 'POST', credentials: 'include', headers: { Authorization: 'Bearer ' + rt, 'Content-Type': 'application/json' }, body: '{}' });
    if (rr.ok) {
      const jj = await rr.json();
      localStorage.setItem('access_token', jj.access_token);
      nextInit.headers['X-Access-Token'] = jj.access_token;
      res = await _origFetch(input, nextInit);
    }
  }
  return res;
};
</script>
</body></html>`);
      return;
    }

    // ───────── Login API ─────────
    if (url === '/api/login' && req.method === 'POST') {
      await readBody(req);
      let sid = cookies['sid'];
      const existing = sid ? sessions.get(sid) : undefined;
      if (!behaviour.allowSessionFixation) {
        // Secure flow: rotate session id on login boundary.
        sid = newToken();
        sessions.set(sid, { userId: 'u1', authed: true, csrf: newToken() });
        setCookie(res, 'sid', sid, { httpOnly: true });
      } else if (existing) {
        // Vulnerable: keep session id from before login.
        existing.authed = true;
        existing.userId = 'u1';
      } else {
        sid = newToken();
        sessions.set(sid, { userId: 'u1', authed: true, csrf: newToken() });
        setCookie(res, 'sid', sid, { httpOnly: true });
      }
      const csrf = sessions.get(sid!)!.csrf;
      setCookie(res, 'XSRF-TOKEN', csrf, { httpOnly: false });
      const access = newToken();
      const refresh = newToken();
      tokens.set(access, { userId: 'u1', expired: false, revoked: false });
      refreshTokens.set(refresh, { userId: 'u1', revoked: false });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ access_token: access, refresh_token: refresh }));
      return;
    }

    // ───────── Refresh API ─────────
    if (url === '/api/refresh' && req.method === 'POST') {
      await readBody(req);
      // Accept refresh token from Authorization header OR body.
      const rt = bearer ?? '';
      const record = refreshTokens.get(rt);
      if (!record || record.revoked) {
        res.statusCode = 401;
        res.end('{}');
        return;
      }
      const access = newToken();
      tokens.set(access, { userId: record.userId, expired: false, revoked: false });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ access_token: access }));
      return;
    }

    // ───────── Logout API ─────────
    if (url === '/api/logout' && req.method === 'POST') {
      const sid = cookies['sid'];
      if (sid) sessions.delete(sid);
      if (!behaviour.keepRefreshValidAfterLogout) {
        // Revoke every refresh token owned by this user.
        for (const [rt, rec] of refreshTokens.entries()) {
          if (rec.userId === 'u1') rec.revoked = true;
          void rt;
        }
        // Revoke all access tokens for this user too.
        for (const [at, rec] of tokens.entries()) {
          if (rec.userId === 'u1') rec.revoked = true;
          void at;
        }
      }
      // Clear client-visible cookies.
      res.setHeader('Set-Cookie', [
        'sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
        'XSRF-TOKEN=; Path=/; Max-Age=0; SameSite=Lax',
      ]);
      res.end('{}');
      return;
    }

    // ───────── Gated route ─────────
    if (url === '/gated' || url.startsWith('/gated?')) {
      const sid = cookies['sid'];
      const sess = sid ? sessions.get(sid) : undefined;
      // Pull bearer from Authorization header or X-Access-Token (SPA-friendly).
      let access = bearer;
      if (!access) access = (req.headers['x-access-token'] ?? null) as string | null;
      const accessRec = access ? tokens.get(access) : undefined;

      const authed = !!(sess?.authed && accessRec && !accessRec.revoked && !accessRec.expired);

      if (req.method === 'POST') {
        // State-changing request: CSRF required unless behaviour says otherwise.
        const csrfHeader = (req.headers['x-csrf-token'] ?? '').toString();
        if (!sess || csrfHeader !== sess.csrf) {
          if (!behaviour.csrfReuseAllowed) {
            res.statusCode = 403;
            res.end('{"err":"bad csrf"}');
            return;
          }
        }
        if (behaviour.rotateCsrfOnStateChange && sess) {
          sess.csrf = newToken();
          setCookie(res, 'XSRF-TOKEN', sess.csrf, { httpOnly: false });
        }
        res.end('{"ok":1}');
        return;
      }

      if (!authed) {
        if (behaviour.silentFailureOnExpiredToken) {
          // Vulnerable: return 200 even for invalid tokens.
          res.setHeader('Content-Type', 'text/html');
          res.end('<html><body><h1>Gated (silently!)</h1></body></html>');
          return;
        }
        // Prefer 401 for XHR/fetch so client can intercept and refresh, with
        // a Location header so standard navigations redirect to login.
        const accept = (req.headers['accept'] ?? '').toString();
        const wantsHtml = accept.includes('text/html');
        res.statusCode = wantsHtml ? 302 : 401;
        res.setHeader('Location', '/login');
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><body><h1>Gated OK</h1></body></html>');
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  return {
    server,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    tokens,
    refreshTokens,
    sessions,
    behaviour,
  };
}

let browser: Browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

async function runWith(
  fixture: ServerHandle,
  overrides: Partial<AuthEdgeConfig> = {},
): Promise<ReturnType<typeof runAuthEdgeAudit>> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const base = `http://127.0.0.1:${fixture.port}`;
  try {
    return await runAuthEdgeAudit(page, {
      loginUrl: `${base}/login`,
      gatedRoute: `${base}/gated`,
      logoutSelector: '#logout',
      refreshEndpoint: `${base}/api/refresh`,
      performLogin: async (p) => {
        await p.click('#go');
        await p.waitForFunction(() => document.body.getAttribute('data-authed') === '1');
      },
      ...overrides,
    });
  } finally {
    await page.close().catch(() => {});
    await ctx.close().catch(() => {});
  }
}

describe('runAuthEdgeAudit', () => {
  test('passes all scenarios against a secure fixture', async () => {
    const fixture = await startServer();
    try {
      const res = await runWith(fixture);
      assert.equal(res.passed, true, `expected pass, got issues: ${JSON.stringify(res.issues)}`);
      const expired = res.scenarios.find((s) => s.scenario === 'expired')!;
      assert.equal(expired.ran, true);
      assert.equal(expired.passed, true);
      const logout = res.scenarios.find((s) => s.scenario === 'logout')!;
      assert.equal(logout.passed, true);
      const fixation = res.scenarios.find((s) => s.scenario === 'fixation')!;
      assert.equal(fixation.passed, true);
      const concurrent = res.scenarios.find((s) => s.scenario === 'concurrent')!;
      assert.equal(concurrent.passed, true);
    } finally {
      await fixture.close();
    }
  });

  test('expired: flags silent failure when server accepts invalid tokens', async () => {
    const fixture = await startServer({ silentFailureOnExpiredToken: true });
    try {
      const res = await runWith(fixture, {
        skipScenarios: ['refresh', 'logout', 'csrf', 'concurrent', 'fixation'],
      });
      const expired = res.scenarios.find((s) => s.scenario === 'expired')!;
      assert.equal(expired.ran, true);
      assert.equal(expired.passed, false);
      assert.ok(
        expired.issues.some((i) => i.kind === 'expired-token-silent-failure'),
        `expected silent-failure issue, got ${JSON.stringify(expired.issues)}`,
      );
    } finally {
      await fixture.close();
    }
  });

  test('logout: flags missing refresh-token revocation', async () => {
    const fixture = await startServer({ keepRefreshValidAfterLogout: true });
    try {
      const res = await runWith(fixture, {
        skipScenarios: ['refresh', 'expired', 'csrf', 'concurrent', 'fixation'],
      });
      const logout = res.scenarios.find((s) => s.scenario === 'logout')!;
      assert.equal(logout.ran, true);
      assert.equal(logout.passed, false);
      assert.ok(
        logout.issues.some((i) => i.kind === 'logout-refresh-not-revoked'),
        `expected logout-refresh-not-revoked, got ${JSON.stringify(logout.issues)}`,
      );
    } finally {
      await fixture.close();
    }
  });

  test('fixation: flags unchanged session cookie across login boundary', async () => {
    const fixture = await startServer({ allowSessionFixation: true });
    try {
      const res = await runWith(fixture, {
        skipScenarios: ['expired', 'refresh', 'logout', 'csrf', 'concurrent'],
      });
      const fix = res.scenarios.find((s) => s.scenario === 'fixation')!;
      assert.equal(fix.ran, true);
      assert.equal(fix.passed, false);
      assert.ok(
        fix.issues.some((i) => i.kind === 'session-fixation'),
        `expected session-fixation, got ${JSON.stringify(fix.issues)}`,
      );
    } finally {
      await fixture.close();
    }
  });

  test('csrf: passes when token rotates on state change', async () => {
    const fixture = await startServer({ rotateCsrfOnStateChange: true });
    try {
      const res = await runWith(fixture, {
        skipScenarios: ['expired', 'refresh', 'logout', 'concurrent', 'fixation'],
      });
      const csrf = res.scenarios.find((s) => s.scenario === 'csrf')!;
      assert.equal(csrf.ran, true);
      // The scenario should pass — token either rotated or cross-session reuse was blocked.
      assert.equal(csrf.passed, true, `csrf should pass: ${JSON.stringify(csrf.issues)}`);
    } finally {
      await fixture.close();
    }
  });

  test('concurrent: flags tab B still authenticated after logout in tab A', async () => {
    // Server that does NOT revoke session across tabs (refresh stays valid).
    // The key hole: logout must not clear server-side session storage.
    // We build a bespoke fixture whose /api/logout is a no-op on the server side.
    const fixture = await startServer();
    // Monkey-patch: stub /api/logout to do nothing server-side.
    fixture.server.removeAllListeners('request');
    fixture.server.on('request', (req, res) => {
      const u = req.url ?? '/';
      if (u === '/api/logout') {
        // Clear client cookies (to satisfy client-cleanup check) but leave server session intact.
        res.setHeader('Set-Cookie', [
          'XSRF-TOKEN=; Path=/; Max-Age=0; SameSite=Lax',
        ]);
        res.end('{}');
        return;
      }
      // Otherwise, fall back to a proxy that re-invokes the default handler.
      // We can't easily reuse the old handler here — instead, ship a tiny
      // always-200 gated response so tab B sees success regardless of tokens.
      if (u.startsWith('/gated')) {
        res.setHeader('Content-Type', 'text/html');
        res.end('<html><body><h1>Gated (hole)</h1></body></html>');
        return;
      }
      if (u === '/' || u === '/login') {
        res.setHeader('Content-Type', 'text/html');
        res.end(`<html><body>
<form id="f" onsubmit="event.preventDefault();doLogin();">
  <button type="submit" id="go">Go</button>
</form>
<a id="logout" href="#" onclick="fetch('/api/logout',{method:'POST',credentials:'include'});return false;">Logout</a>
<script>
function doLogin(){localStorage.setItem('access_token','x');document.body.setAttribute('data-authed','1');}
</script>
</body></html>`);
        return;
      }
      res.statusCode = 404;
      res.end('nf');
    });

    try {
      const base = `http://127.0.0.1:${fixture.port}`;
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      try {
        const res = await runAuthEdgeAudit(page, {
          loginUrl: `${base}/login`,
          gatedRoute: `${base}/gated`,
          logoutSelector: '#logout',
          performLogin: async (p) => {
            await p.click('#go');
            await p.waitForFunction(() => document.body.getAttribute('data-authed') === '1');
          },
          skipScenarios: ['expired', 'refresh', 'logout', 'csrf', 'fixation'],
        });
        const concurrent = res.scenarios.find((s) => s.scenario === 'concurrent')!;
        assert.equal(concurrent.ran, true);
        assert.equal(concurrent.passed, false);
        assert.ok(
          concurrent.issues.some((i) => i.kind === 'concurrent-logout-still-valid'),
          `expected concurrent-logout-still-valid, got ${JSON.stringify(concurrent.issues)}`,
        );
      } finally {
        await page.close().catch(() => {});
        await ctx.close().catch(() => {});
      }
    } finally {
      await fixture.close();
    }
  });

  test('skipScenarios respected — skipped scenarios report ran=false', async () => {
    const fixture = await startServer();
    try {
      const res = await runWith(fixture, {
        skipScenarios: ['expired', 'refresh', 'logout', 'csrf', 'concurrent', 'fixation'],
      });
      assert.equal(res.scenarios.length, 6);
      for (const s of res.scenarios) assert.equal(s.ran, false);
      assert.equal(res.passed, true);
    } finally {
      await fixture.close();
    }
  });

  test('throws without loginUrl / gatedRoute', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await assert.rejects(
        () =>
          runAuthEdgeAudit(page, {
            loginUrl: '',
            gatedRoute: 'http://x',
          } as AuthEdgeConfig),
        /loginUrl/,
      );
      await assert.rejects(
        () =>
          runAuthEdgeAudit(page, {
            loginUrl: 'http://x',
            gatedRoute: '',
          } as AuthEdgeConfig),
        /gatedRoute/,
      );
    } finally {
      await page.close().catch(() => {});
      await ctx.close().catch(() => {});
    }
  });
});
