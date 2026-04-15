import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { auditConcurrency } from './concurrency-audit.js';

let browser: Browser;
const pages: Record<string, string> = {};
let server: http.Server;
let baseUrl = '';

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = (req.url ?? '/').split('?')[0]!;
      const body = pages[url] ?? '<html><body>not found</body></html>';
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

before(async () => {
  browser = await chromium.launch({ headless: true });
  await startServer();
});

after(async () => {
  await browser?.close();
  await stopServer();
});

const LAST_WRITE_WINS_NO_WARNING = `
<!doctype html>
<html><body>
  <input id="title" />
  <button id="save">Save</button>
  <div id="status"></div>
  <div id="warning"></div>
  <script>
    const KEY = 'record-title';
    const VKEY = 'record-version';
    const input = document.getElementById('title');
    const status = document.getElementById('status');
    function render() {
      input.value = localStorage.getItem(KEY) || '';
    }
    render();
    document.getElementById('save').addEventListener('click', () => {
      // Naive last-write-wins, no version check, no warning ever rendered.
      localStorage.setItem(KEY, input.value);
      localStorage.setItem(VKEY, String((Number(localStorage.getItem(VKEY)) || 0) + 1));
      status.textContent = 'saved';
    });
  </script>
</body></html>
`;

const PROPER_WARNING_APP = `
<!doctype html>
<html><body>
  <input id="title" />
  <button id="save">Save</button>
  <div id="status"></div>
  <div id="warning"></div>
  <script>
    const KEY = 'record-title';
    const VKEY = 'record-version';
    const input = document.getElementById('title');
    const status = document.getElementById('status');
    const warning = document.getElementById('warning');
    let loadedVersion = Number(localStorage.getItem(VKEY)) || 0;
    function render() {
      input.value = localStorage.getItem(KEY) || '';
      loadedVersion = Number(localStorage.getItem(VKEY)) || 0;
    }
    render();
    document.getElementById('save').addEventListener('click', () => {
      const current = Number(localStorage.getItem(VKEY)) || 0;
      if (current !== loadedVersion) {
        warning.textContent = 'edited by another tab';
        status.textContent = 'blocked';
        return;
      }
      localStorage.setItem(KEY, input.value);
      localStorage.setItem(VKEY, String(current + 1));
      loadedVersion = current + 1;
      status.textContent = 'saved';
    });
  </script>
</body></html>
`;

const CROSS_TAB_LOGOUT_BROKEN = `
<!doctype html>
<html><body>
  <button id="logout">Logout</button>
  <button id="doAuthed">Authed</button>
  <div id="authed"></div>
  <div id="identity"></div>
  <script>
    const AUTH = 'auth-user';
    if (!localStorage.getItem(AUTH)) localStorage.setItem(AUTH, 'alice');
    document.getElementById('identity').textContent = localStorage.getItem(AUTH) || 'anon';
    document.getElementById('logout').addEventListener('click', () => {
      localStorage.removeItem(AUTH);
    });
    // BROKEN: action succeeds regardless of auth state.
    document.getElementById('doAuthed').addEventListener('click', () => {
      document.getElementById('authed').textContent = 'ok';
    });
  </script>
</body></html>
`;

const SESSION_SWAP_APP = `
<!doctype html>
<html><body>
  <div id="identity"></div>
  <button id="relogin">Relogin</button>
  <script>
    const AUTH = 'auth-user';
    if (!localStorage.getItem(AUTH)) localStorage.setItem(AUTH, 'alice');
    document.getElementById('identity').textContent = localStorage.getItem(AUTH);
    document.getElementById('relogin').addEventListener('click', () => {
      localStorage.setItem(AUTH, 'bob');
      // DOM is not updated in-place, but reload reads from storage, so audit passes.
    });
  </script>
</body></html>
`;

pages['/no-warning'] = LAST_WRITE_WINS_NO_WARNING;
pages['/with-warning'] = PROPER_WARNING_APP;
pages['/logout-broken'] = CROSS_TAB_LOGOUT_BROKEN;
pages['/session-swap'] = SESSION_SWAP_APP;

describe('auditConcurrency — conflicting saves', () => {
  test('flags silent overwrite when app has no stale-write warning', async () => {
    const result = await auditConcurrency(browser, {
      url: `${baseUrl}/no-warning`,
      navTimeoutMs: 5_000,
      actions: {
        conflictingSave: {
          editA: async (p) => p.fill('#title', 'from-A'),
          editB: async (p) => p.fill('#title', 'from-B'),
          saveA: async (p) => p.click('#save'),
          saveB: async (p) => p.click('#save'),
          warningDetector: async (p) => {
            const txt = await p.locator('#warning').innerText().catch(() => '');
            return txt.trim().length > 0;
          },
        },
      },
    });

    assert.equal(result.ranConflictingSaves, true);
    assert.equal(result.silentOverwrite, true);
    assert.equal(result.passed, false);
    assert.ok(result.evidence.some((e) => e.test === 'conflicting-saves'));
  });

  test('passes when app surfaces an "edited by another tab" warning', async () => {
    // Contexts are isolated so we simulate a shared-store conflict by pre-seeding
    // tab B's version counter to a higher value before it saves. The proper app
    // will then render the stale-write warning because loaded != current.
    const result = await auditConcurrency(browser, {
      url: `${baseUrl}/with-warning`,
      navTimeoutMs: 5_000,
      actions: {
        conflictingSave: {
          editA: async (p) => p.fill('#title', 'from-A'),
          editB: async (p) => {
            await p.evaluate(() => {
              localStorage.setItem('record-version', '99');
            });
            await p.fill('#title', 'from-B');
          },
          saveA: async (p) => p.click('#save'),
          saveB: async (p) => p.click('#save'),
          warningDetector: async (p) => {
            const txt = await p.locator('#warning').innerText().catch(() => '');
            return txt.includes('edited by another tab');
          },
        },
      },
    });

    assert.equal(result.ranConflictingSaves, true);
    assert.equal(result.silentOverwrite, false);
    assert.equal(result.passed, true);
    assert.ok(
      result.evidence.some((e) => e.detail.includes('stale-write warning')),
      `evidence was: ${JSON.stringify(result.evidence)}`,
    );
  });
});

describe('auditConcurrency — cross-tab logout', () => {
  test('flags broken cross-tab logout when authed action still succeeds', async () => {
    const result = await auditConcurrency(browser, {
      url: `${baseUrl}/logout-broken`,
      navTimeoutMs: 5_000,
      actions: {
        crossTabLogout: {
          logout: async (p) => p.click('#logout'),
          authedAction: async (p) => p.click('#doAuthed'),
          actionSucceeded: async (p) => {
            const txt = await p.locator('#authed').innerText().catch(() => '');
            return txt.trim() === 'ok';
          },
        },
      },
    });

    assert.equal(result.ranCrossTabLogout, true);
    assert.equal(
      result.crossTabLogoutBroken,
      true,
      `evidence: ${JSON.stringify(result.evidence)}`,
    );
    assert.equal(result.passed, false);
  });
});

describe('auditConcurrency — no actions provided', () => {
  test('gracefully no-ops when nothing configured', async () => {
    const result = await auditConcurrency(browser, {
      url: `${baseUrl}/no-warning`,
      navTimeoutMs: 5_000,
    });
    assert.equal(result.ranConflictingSaves, false);
    assert.equal(result.ranCrossTabLogout, false);
    assert.equal(result.ranSessionSwap, false);
    assert.equal(result.silentOverwrite, false);
    assert.equal(result.crossTabLogoutBroken, false);
    assert.equal(result.sessionSyncBroken, false);
    assert.equal(result.passed, true);
    assert.equal(result.evidence.length, 0);
  });
});

describe('auditConcurrency — session swap', () => {
  test('tab B re-reads identity on reload after tab A relogs (passes)', async () => {
    const result = await auditConcurrency(browser, {
      url: `${baseUrl}/session-swap`,
      navTimeoutMs: 5_000,
      actions: {
        sessionSwap: {
          loginOther: async (p) => p.click('#relogin'),
          probeIdentity: async (p) => {
            return await p.locator('#identity').innerText().catch(() => '');
          },
        },
      },
    });

    assert.equal(result.ranSessionSwap, true);
    // Shared context, reload reads from localStorage, so identity swaps alice->bob.
    assert.equal(
      result.sessionSyncBroken,
      false,
      `evidence: ${JSON.stringify(result.evidence)}`,
    );
    assert.equal(result.passed, true);
  });
});
