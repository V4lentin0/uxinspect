import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { attachReplayCapture, replayFilePath, sanitizeFlowName, type ReplayEvent } from './replay.js';

/** Minimal Page mock that records calls made by attachReplayCapture. */
function mockPage() {
  const calls: { addInitScript: string[]; exposeFunction: string[] } = {
    addInitScript: [],
    exposeFunction: [],
  };
  const bindings = new Map<string, (...args: any[]) => any>();
  const page = {
    async addInitScript(arg: { content: string } | string) {
      const content = typeof arg === 'string' ? arg : arg.content;
      calls.addInitScript.push(content);
    },
    async exposeFunction(name: string, fn: (...args: any[]) => any) {
      calls.exposeFunction.push(name);
      bindings.set(name, fn);
    },
  };
  return { page: page as any, calls, bindings };
}

test('sanitizeFlowName replaces unsafe characters', () => {
  assert.equal(sanitizeFlowName('Login Flow'), 'login-flow');
  assert.equal(sanitizeFlowName('foo/bar..baz'), 'foo-bar..baz');
  assert.equal(sanitizeFlowName('  ---  '), 'flow');
  assert.equal(sanitizeFlowName(''), 'flow');
});

test('replayFilePath follows <outDir>/replays/<flow>-<ts>.json format', () => {
  const p = replayFilePath('/tmp/report', 'Checkout Flow', 1700000000000);
  assert.equal(p, path.resolve('/tmp/report', 'replays', 'checkout-flow-1700000000000.json'));
});

test('attachReplayCapture injects rrweb bundle + exposes push binding', async () => {
  const { page, calls, bindings } = mockPage();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'uxi-replay-'));
  try {
    const handle = await attachReplayCapture(page, 'home', tmp);
    assert.equal(calls.exposeFunction.length, 1);
    assert.equal(calls.exposeFunction[0], '__uxiReplayPush');
    assert.equal(calls.addInitScript.length, 1);
    const script = calls.addInitScript[0]!;
    assert.ok(script.includes('rrweb.record'), 'init script should call rrweb.record');
    assert.ok(script.includes('__uxiReplayStarted'), 'init script should guard against double-boot');
    assert.ok(script.includes('__uxiReplayPush'), 'init script should call the exposed push');
    // rrweb UMD bundle should be inlined so the page doesn't need network.
    assert.ok(script.length > 50_000, 'rrweb bundle should be inlined (large)');
    assert.ok(bindings.has('__uxiReplayPush'));
    assert.equal(handle.flowName, 'home');
    assert.ok(handle.outputPath.endsWith('.json'));
    assert.ok(handle.outputPath.includes(path.join('replays', 'home-')));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('attachReplayCapture buffers events and writes JSON on flush', async () => {
  const { page, bindings } = mockPage();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'uxi-replay-'));
  try {
    const handle = await attachReplayCapture(page, 'checkout', tmp);
    const push = bindings.get('__uxiReplayPush')!;
    // Simulate rrweb emitting three events of different types.
    const e1: ReplayEvent = { type: 4, data: { href: 'https://x' }, timestamp: 1 };
    const e2: ReplayEvent = { type: 2, data: { node: {} }, timestamp: 2 };
    const e3: ReplayEvent = { type: 3, data: { source: 0 }, timestamp: 3 };
    push(e1); push(e2); push(e3);
    // Non-event garbage is filtered.
    push(null);
    push({ nope: true });
    assert.equal(handle.events().length, 3);

    const outPath = await handle.flush();
    assert.equal(outPath, handle.outputPath);
    const raw = await fs.readFile(outPath, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.flowName, 'checkout');
    assert.equal(parsed.events.length, 3);
    assert.equal(parsed.events[0].type, 4);
    assert.equal(parsed.events[2].timestamp, 3);
    assert.equal(typeof parsed.startedAt, 'string');
    assert.equal(typeof parsed.durationMs, 'number');
    assert.ok(parsed.durationMs >= 0);

    // Events pushed after flush must not mutate the file.
    push({ type: 5, data: {}, timestamp: 4 });
    const raw2 = await fs.readFile(outPath, 'utf8');
    assert.equal(JSON.parse(raw2).events.length, 3);

    // Double-flush is a no-op and returns the same path.
    const again = await handle.flush();
    assert.equal(again, outPath);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('attachReplayCapture outputs file path in <outDir>/replays/<flow>-<ts>.json format', async () => {
  const { page } = mockPage();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'uxi-replay-'));
  try {
    const before = Date.now();
    const handle = await attachReplayCapture(page, 'Login Flow!', tmp);
    const after = Date.now();
    const dir = path.dirname(handle.outputPath);
    assert.equal(dir, path.join(tmp, 'replays'));
    const base = path.basename(handle.outputPath);
    const m = base.match(/^login-flow-(\d+)\.json$/);
    assert.ok(m, `filename ${base} should match <flow>-<ts>.json`);
    const ts = Number(m![1]);
    assert.ok(ts >= before && ts <= after, 'timestamp should be unix-ms captured at attach');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
