import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { auditEmailRendering } from './email-audit.js';

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

interface FakeMsg {
  id: string;
  subject: string;
  from: { name: string; address: string };
  to: { name: string; address: string }[];
  html: string;
  text: string;
}

function startFakeMailpit(messagesRef: { current: FakeMsg[] }): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const send = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/api/v1/info') {
        return send(200, { Version: 'fake-mailpit' });
      }
      if (url.pathname === '/api/v1/messages') {
        const messages = messagesRef.current.map((m) => ({
          ID: m.id,
          Subject: m.subject,
          From: m.from,
          To: m.to,
          Created: new Date().toISOString(),
        }));
        return send(200, { messages, total: messages.length });
      }
      const msgMatch = url.pathname.match(/^\/api\/v1\/message\/(.+)$/);
      if (msgMatch) {
        const id = decodeURIComponent(msgMatch[1]!);
        const m = messagesRef.current.find((x) => x.id === id);
        if (!m) return send(404, { error: 'not found' });
        return send(200, {
          ID: m.id,
          Subject: m.subject,
          From: m.from,
          To: m.to,
          HTML: m.html,
          Text: m.text,
          Date: new Date().toISOString(),
        });
      }
      send(404, { error: 'not found' });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((done, fail) =>
            server.close((err) => (err ? fail(err) : done())),
          ),
      });
    });
  });
}

describe('auditEmailRendering', () => {
  test('skips gracefully when mailpit and mailhog are unreachable', async () => {
    const page = await newPage();
    try {
      const result = await auditEmailRendering(page, {
        mailpitUrl: 'http://127.0.0.1:1',
        mailhogUrl: 'http://127.0.0.1:1',
        timeoutMs: 500,
      });
      assert.equal(result.skipped, true);
      assert.equal(result.emailFound, false);
      assert.equal(result.passed, true);
      assert.ok(result.warnings.length >= 2);
    } finally {
      await page.close();
    }
  });

  test('captures fake mailpit email and screenshots each client', async () => {
    const messagesRef = { current: [] as FakeMsg[] };
    const server = await startFakeMailpit(messagesRef);
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxi-email-'));
    const page = await newPage();
    try {
      const result = await auditEmailRendering(page, {
        mailpitUrl: server.url,
        expectedSubject: 'Reset your password',
        triggerAction: async () => {
          messagesRef.current.push({
            id: 'msg-1',
            subject: 'Reset your password',
            from: { name: 'App', address: 'noreply@app.test' },
            to: [{ name: 'User', address: 'user@test' }],
            html: '<div style="display:flex"><h1>Hello</h1><a href="https://example.com/reset">Reset</a></div>',
            text: 'Reset your password: https://example.com/reset',
          });
        },
        outputDir,
        timeoutMs: 5_000,
        pollMs: 100,
        clients: ['gmail-web', 'apple-mail-web', 'outlook-web'],
      });

      assert.equal(result.emailFound, true);
      assert.equal(result.provider, 'mailpit');
      assert.equal(result.subject, 'Reset your password');
      assert.equal(result.messageId, 'msg-1');
      assert.ok(result.htmlBody?.includes('Hello'));
      assert.equal(typeof result.screenshots['gmail-web'], 'string');
      assert.equal(typeof result.screenshots['apple-mail-web'], 'string');
      assert.equal(typeof result.screenshots['outlook-web'], 'string');
      for (const p of Object.values(result.screenshots)) {
        const stat = await fs.stat(p!);
        assert.ok(stat.size > 0, `screenshot ${p} should be non-empty`);
      }
      // outlook-web should flag flexbox usage
      assert.ok(
        result.issues.some((i) => i.client === 'outlook-web' && /flex/i.test(i.issue)),
        'expected outlook flex warning',
      );
    } finally {
      await page.close();
      await server.close();
      await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('returns emailFound=false when trigger produces no matching email', async () => {
    const messagesRef = { current: [] as FakeMsg[] };
    const server = await startFakeMailpit(messagesRef);
    const page = await newPage();
    try {
      const result = await auditEmailRendering(page, {
        mailpitUrl: server.url,
        expectedSubject: 'Something else entirely',
        timeoutMs: 600,
        pollMs: 100,
      });
      assert.equal(result.emailFound, false);
      assert.equal(result.provider, 'mailpit');
      assert.equal(result.passed, false);
      assert.ok(result.warnings.some((w) => /no matching email/.test(w)));
    } finally {
      await page.close();
      await server.close();
    }
  });

  test('ignores emails that existed before triggerAction', async () => {
    const messagesRef = {
      current: [
        {
          id: 'old-1',
          subject: 'Reset your password',
          from: { name: 'App', address: 'a@b.test' },
          to: [{ name: 'U', address: 'u@t.test' }],
          html: '<p>old</p>',
          text: 'old',
        },
      ] as FakeMsg[],
    };
    const server = await startFakeMailpit(messagesRef);
    const page = await newPage();
    try {
      const result = await auditEmailRendering(page, {
        mailpitUrl: server.url,
        expectedSubject: 'Reset your password',
        timeoutMs: 600,
        pollMs: 100,
        // no triggerAction; no new email should be found
      });
      assert.equal(result.emailFound, false);
    } finally {
      await page.close();
      await server.close();
    }
  });
});
