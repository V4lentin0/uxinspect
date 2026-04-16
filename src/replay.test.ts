/**
 * P0 #2 — rrweb replay capture tests.
 *
 * Verifies startReplay injects rrweb into the page, captures events during
 * interaction, and stopReplay writes a JSON file with the collected events.
 * All tests use a real chromium page so the rrweb bundle is exercised end-to-end.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { startReplay, stopReplay } from './replay.js';

let browser: Browser;
let context: BrowserContext;
let tmpBase: string;

before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 320, height: 240 } });
  tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-replay-'));
});

after(async () => {
  await context?.close();
  await browser?.close();
  try {
    await fs.rm(tmpBase, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('startReplay returns a session with injected=true when rrweb is available', async () => {
  const baseDir = path.join(tmpBase, 'case1');
  const page = await context.newPage();
  await page.setContent('<html><body><p>hello</p></body></html>', { waitUntil: 'load' });
  const session = await startReplay(page, 'case-one', { baseDir });
  assert.ok(session);
  assert.equal(session!.injected, true);
  assert.equal(session!.flowName, 'case-one');
  await stopReplay(session);
  await page.close();
});

test('replay captures rrweb events during interaction and writes JSON', async () => {
  const baseDir = path.join(tmpBase, 'case2');
  const page = await context.newPage();
  const session = await startReplay(page, 'interaction-flow', { baseDir });
  assert.ok(session);
  // setContent after startReplay so addInitScript fires on the new document.
  await page.setContent(
    '<html><body><button id="b">click me</button><input id="i"/></body></html>',
    { waitUntil: 'load' },
  );
  // Wait a beat so rrweb emits the FullSnapshot event.
  await page.waitForTimeout(200);
  await page.click('#b');
  await page.fill('#i', 'typed text');
  await page.waitForTimeout(200);

  const filePath = await stopReplay(session);
  assert.ok(filePath, 'stopReplay should return a file path');
  const stat = await fs.stat(filePath!);
  assert.ok(stat.isFile());
  const raw = await fs.readFile(filePath!, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.flow, 'interaction-flow');
  assert.ok(typeof parsed.startedAt === 'string');
  assert.ok(typeof parsed.endedAt === 'string');
  assert.ok(Array.isArray(parsed.events));
  assert.ok(parsed.events.length > 0, 'should have captured at least one event');
  assert.equal(parsed.eventCount, parsed.events.length);
  // rrweb emits a Meta (type 4) + FullSnapshot (type 2) at the start.
  const types = new Set(parsed.events.map((e: { type: number }) => e.type));
  assert.ok(types.has(2), 'should include FullSnapshot event');
  await page.close();
});

test('stopReplay returns null when no events were captured', async () => {
  // Skip startReplay entirely — pass an injected=false session to simulate
  // the case where rrweb failed to install.
  const result = await stopReplay({
    flowName: 'nothing',
    page: (await context.newPage()) as never,
    startedAt: new Date().toISOString(),
    baseDir: path.join(tmpBase, 'case3'),
    injected: false,
  });
  assert.equal(result, null);
});

test('stopReplay is a no-op when passed null', async () => {
  assert.equal(await stopReplay(null), null);
});

test('replay file name is safe — flow name sanitized + ISO timestamp', async () => {
  const baseDir = path.join(tmpBase, 'case4');
  const page = await context.newPage();
  const session = await startReplay(page, 'Has Spaces / And Colons:!', { baseDir });
  assert.ok(session);
  await page.setContent('<html><body>x</body></html>');
  await page.waitForTimeout(100);
  const filePath = await stopReplay(session);
  assert.ok(filePath);
  const base = path.basename(filePath!);
  // sanitizeFlowName collapses unsafe chars to '-'.
  assert.match(base, /^Has-Spaces-And-Colons-.*\.json$/);
  // No colons or slashes in the final filename.
  assert.ok(!base.includes(':'));
  assert.ok(!base.includes('/'));
  await page.close();
});
