import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AIHelper, extractCssSelector } from './ai.js';
import { Driver } from './driver.js';

type Handler = (body: any) => { status?: number; body: string; delayMs?: number };

function startMockOllama(handler: Handler): Promise<{ url: string; server: Server; calls: number }> {
  return new Promise((resolve) => {
    let calls = 0;
    const server = createServer((req, res) => {
      if (req.url !== '/api/generate' || req.method !== 'POST') {
        res.statusCode = 404;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(Buffer.from(c)));
      req.on('end', () => {
        calls++;
        let parsed: any = {};
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          /* ignore */
        }
        const out = handler(parsed);
        const write = () => {
          res.statusCode = out.status ?? 200;
          res.setHeader('content-type', 'application/json');
          res.end(out.body);
        };
        if (out.delayMs) setTimeout(write, out.delayMs);
        else write();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        server,
        get calls() {
          return calls;
        },
      } as any);
    });
  });
}

function stopServer(s: Server): Promise<void> {
  return new Promise((r) => s.close(() => r()));
}

// ─── extractCssSelector unit ────────────────────────────────────────
test('extractCssSelector strips markdown fences and prose', () => {
  assert.equal(extractCssSelector('```css\n#submit-btn\n```'), '#submit-btn');
  assert.equal(extractCssSelector('Selector: .primary-cta'), '.primary-cta');
  assert.equal(extractCssSelector('button[data-testid="go"]'), 'button[data-testid="go"]');
  assert.equal(extractCssSelector('   "#x"   '), '#x');
});

test('extractCssSelector rejects prose and garbage', () => {
  assert.equal(extractCssSelector(''), null);
  assert.equal(extractCssSelector('I think the selector is something'), null);
  assert.equal(extractCssSelector('   '), null);
});

// ─── cache hit skips heuristic re-resolution ────────────────────────
test('AIHelper caches resolved locator across repeat calls', async () => {
  const driver = new Driver();
  await driver.launch({ headless: true });
  const page = await driver.newPage();
  await page.setContent(`
    <html><body>
      <button data-testid="save-btn">Save changes</button>
    </body></html>
  `);
  const ai = new AIHelper();
  await ai.init(page);

  assert.equal(await ai.act('click save changes'), true);
  assert.ok(ai.cacheSize() > 0, 'cache populated after first resolve');
  const sizeAfterFirst = ai.cacheSize();

  // Second call: cache hit → same action succeeds
  assert.equal(await ai.act('click save changes'), true);
  assert.equal(ai.cacheSize(), sizeAfterFirst, 'cache size unchanged on hit');

  await driver.close();
});

// ─── cache invalidation on stale selector ───────────────────────────
test('AIHelper evicts cache entry when cached selector goes stale', async () => {
  const driver = new Driver();
  await driver.launch({ headless: true });
  const page = await driver.newPage();
  await page.setContent(`
    <html><body>
      <button data-testid="delete-btn">Delete row</button>
    </body></html>
  `);
  const ai = new AIHelper();
  await ai.init(page);
  assert.equal(await ai.act('click delete row'), true);
  const keysBefore = ai.cacheSize();
  assert.ok(keysBefore > 0);

  // Swap DOM so the cached testid points to nothing, but a role/text match still exists.
  await page.setContent(`
    <html><body>
      <button>Delete row</button>
    </body></html>
  `);

  // Next call: cached selector fails → evicted → heuristic re-resolves and repopulates.
  assert.equal(await ai.act('click delete row'), true);
  assert.ok(ai.cacheSize() > 0, 'cache rebuilt after eviction');

  await driver.close();
});

// ─── Ollama mock returns valid selector, AIHelper uses it ───────────
test('AIHelper uses Ollama fallback when heuristic exhausts', async () => {
  const driver = new Driver();
  await driver.launch({ headless: true });
  const page = await driver.newPage();
  // No matching role/label/placeholder/text → heuristic fails.
  // But a plain <div> with a distinguishable id exists, which Ollama will "suggest".
  await page.setContent(`
    <html><body>
      <div id="mystery-widget">opaque widget body</div>
    </body></html>
  `);

  const ollama = await startMockOllama(() => ({
    body: JSON.stringify({ response: '#mystery-widget' }),
  }));

  const ai = new AIHelper({
    fallback: { ollama: { enabled: true, url: ollama.url, model: 'test', timeoutMs: 5000 } },
  });
  await ai.init(page);

  // Verb "click" on target that the heuristic cannot locate via role/label/etc.
  const ok = await ai.act('click the mystery widget');
  assert.equal(ok, true, 'Ollama-suggested selector was used');
  assert.ok(ai.cacheSize() > 0, 'Ollama-derived selector was cached');

  await stopServer(ollama.server);
  await driver.close();
});

// ─── Ollama failure falls through to error (act returns false) ──────
test('AIHelper falls through when Ollama is unreachable', async () => {
  const driver = new Driver();
  await driver.launch({ headless: true });
  const page = await driver.newPage();
  await page.setContent('<html><body><div>no matches here</div></body></html>');

  // Port 1 is guaranteed closed on a sane host.
  const ai = new AIHelper({
    fallback: {
      ollama: { enabled: true, url: 'http://127.0.0.1:1', model: 'x', timeoutMs: 500 },
    },
  });
  await ai.init(page);

  assert.equal(await ai.act('click nonexistent-target-xyz'), false);

  await driver.close();
});

// ─── Ollama invalid response → fall through, no crash ───────────────
test('AIHelper rejects invalid Ollama response gracefully', async () => {
  const driver = new Driver();
  await driver.launch({ headless: true });
  const page = await driver.newPage();
  await page.setContent('<html><body><div>no matches here</div></body></html>');

  const ollama = await startMockOllama(() => ({
    body: JSON.stringify({ response: 'sorry I cannot help with that' }),
  }));

  const ai = new AIHelper({
    fallback: { ollama: { enabled: true, url: ollama.url, model: 'x', timeoutMs: 2000 } },
  });
  await ai.init(page);

  assert.equal(await ai.act('click nonexistent-target-xyz'), false);

  await stopServer(ollama.server);
  await driver.close();
});

// ─── Ollama disabled by default (backward compat) ───────────────────
test('AIHelper does not call Ollama when disabled', async () => {
  const driver = new Driver();
  await driver.launch({ headless: true });
  const page = await driver.newPage();
  await page.setContent('<html><body><div>only a div</div></body></html>');

  let called = 0;
  const ollama = await startMockOllama(() => {
    called++;
    return { body: JSON.stringify({ response: 'div' }) };
  });

  // Default opts: no fallback config → Ollama must NOT be called.
  const ai = new AIHelper();
  await ai.init(page);
  await ai.act('click nothing-here');
  assert.equal(called, 0, 'Ollama was not contacted');

  await stopServer(ollama.server);
  await driver.close();
});
