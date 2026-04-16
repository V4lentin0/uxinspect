/**
 * P0 #3 — Tests for the single-file rrweb replay viewer.
 *
 * renderReplayViewer produces a self-contained HTML document that inlines
 * the rrweb-player UMD bundle + stylesheet. These tests cover:
 *   - HTML structure + required inline assets
 *   - Events are serialized safely (no `</script>` injection)
 *   - File loader accepts both bare-array JSON and `{ events: [...] }`
 *   - Error paths: non-array events, <2 events, invalid JSON
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  renderReplayViewer,
  renderReplayViewerFromFile,
  writeReplayViewer,
} from './replay-viewer.js';

// Minimal two-event rrweb-shaped payload. We don't need schema-validity —
// only the viewer's own assertions exercise it, and the player itself is
// only invoked in a real browser.
function minimalEvents(): unknown[] {
  return [
    { type: 4, data: { href: 'about:blank', width: 320, height: 240 }, timestamp: 0 },
    { type: 2, data: { node: { type: 0, childNodes: [] } }, timestamp: 10 },
  ];
}

test('renderReplayViewer emits a self-contained HTML document', async () => {
  const html = await renderReplayViewer(minimalEvents(), { title: 'demo' });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.match(html, /<title>demo<\/title>/);
  // rrweb-player UMD bundle must be inlined (not fetched).
  assert.ok(html.includes('rrwebPlayer'), 'player global should be referenced');
  assert.ok(html.length > 50_000, 'viewer should inline the rrweb-player bundle');
  // Events payload must be present as a JS literal under __REPLAY_EVENTS__.
  assert.ok(html.includes('__REPLAY_EVENTS__'));
  // CSP must forbid network connects.
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src 'none'/);
});

test('events are escaped so a `</script>` payload cannot break out', async () => {
  const events = [
    { type: 4, data: { href: '</script><script>alert(1)</script>' }, timestamp: 0 },
    { type: 2, data: {}, timestamp: 10 },
  ];
  const html = await renderReplayViewer(events);
  // The raw closing-tag sequence must NOT appear in the inlined JSON — it
  // would terminate the host <script> block and allow injection.
  const firstEventIdx = html.indexOf('__REPLAY_EVENTS__');
  const tail = html.slice(firstEventIdx);
  assert.ok(
    !tail.includes('</script><script>alert(1)</script>'),
    'raw attack string must be escaped in the inlined JSON',
  );
});

test('renderReplayViewer rejects non-array input', async () => {
  await assert.rejects(
    // @ts-expect-error — deliberately wrong type
    () => renderReplayViewer({ not: 'an-array' }),
    /must be an array/,
  );
});

test('renderReplayViewer rejects too-few events', async () => {
  await assert.rejects(() => renderReplayViewer([]), /at least 2/);
  await assert.rejects(
    () => renderReplayViewer([{ type: 4, data: {}, timestamp: 0 }]),
    /at least 2/,
  );
});

test('renderReplayViewerFromFile accepts bare-array JSON', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-rv-'));
  const file = path.join(dir, 'bare.json');
  await fs.writeFile(file, JSON.stringify(minimalEvents()));
  try {
    const html = await renderReplayViewerFromFile(file);
    assert.ok(html.startsWith('<!doctype html>'));
    assert.match(html, /uxinspect replay — bare\.json/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('renderReplayViewerFromFile accepts `{ events: [...] }` wrapper', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-rv-'));
  const file = path.join(dir, 'wrapped.json');
  const payload = {
    flow: 'checkout',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:05.000Z',
    eventCount: 2,
    events: minimalEvents(),
  };
  await fs.writeFile(file, JSON.stringify(payload));
  try {
    const html = await renderReplayViewerFromFile(file);
    assert.ok(html.includes('__REPLAY_EVENTS__'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('renderReplayViewerFromFile rejects invalid JSON', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-rv-'));
  const file = path.join(dir, 'broken.json');
  await fs.writeFile(file, '{ not valid json');
  try {
    await assert.rejects(() => renderReplayViewerFromFile(file), /invalid JSON/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('writeReplayViewer writes a complete HTML file to disk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-rv-'));
  const src = path.join(dir, 'events.json');
  const dst = path.join(dir, 'out', 'viewer.html');
  await fs.writeFile(src, JSON.stringify({ events: minimalEvents() }));
  try {
    const written = await writeReplayViewer(src, dst, { title: 'written' });
    assert.equal(written, path.resolve(dst));
    const html = await fs.readFile(written, 'utf8');
    assert.match(html, /<title>written<\/title>/);
    assert.ok(html.length > 50_000);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
