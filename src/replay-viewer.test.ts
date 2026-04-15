import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateReplayViewerHtml } from './replay-viewer.js';

async function writeSampleReplay(dir: string): Promise<string> {
  const replayPath = path.join(dir, 'replay.json');
  const events = [
    { type: 4, data: { href: 'https://example.com', width: 1280, height: 800 }, timestamp: 1000 },
    { type: 2, data: { node: { type: 0, childNodes: [], id: 1 } }, timestamp: 1001 },
    { type: 3, data: { source: 1, positions: [{ x: 10, y: 20, id: 1, timeOffset: 0 }] }, timestamp: 1500 },
  ];
  const replay = {
    events,
    version: 1,
    flowName: 'test-flow',
    startedAt: 1700000000000,
    durationMs: 5000,
  };
  await fs.writeFile(replayPath, JSON.stringify(replay));
  return replayPath;
}

test('generateReplayViewerHtml embeds events array in output', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-viewer-'));
  try {
    const replayPath = await writeSampleReplay(dir);
    const html = await generateReplayViewerHtml(replayPath);
    assert.ok(html.includes('"type":4'), 'html should embed event type 4');
    assert.ok(html.includes('"type":2'), 'html should embed event type 2');
    assert.ok(html.includes('"type":3'), 'html should embed event type 3');
    assert.ok(html.includes('"timestamp":1000'), 'html should embed event timestamp');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('generateReplayViewerHtml contains rrweb-player script bundle inline', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-viewer-'));
  try {
    const replayPath = await writeSampleReplay(dir);
    const html = await generateReplayViewerHtml(replayPath);
    // rrweb-player IIFE exposes a global called rrwebPlayer
    assert.ok(html.includes('rrwebPlayer'), 'html should contain rrwebPlayer global');
    // must be inline (no CDN / external URL references)
    assert.ok(!/<script[^>]+src=/i.test(html), 'html should not load external scripts');
    assert.ok(!/<link[^>]+rel=["']?stylesheet/i.test(html), 'html should not load external stylesheets');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('generateReplayViewerHtml produces valid html document', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-viewer-'));
  try {
    const replayPath = await writeSampleReplay(dir);
    const html = await generateReplayViewerHtml(replayPath);
    assert.match(html, /<html[\s>]/i, 'should contain <html> tag');
    assert.match(html, /<\/html>/i, 'should contain closing </html> tag');
    assert.match(html, /<head>/i);
    assert.match(html, /<body>/i);
    assert.match(html, /<!doctype html>/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('generateReplayViewerHtml renders header metadata', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-viewer-'));
  try {
    const replayPath = await writeSampleReplay(dir);
    const html = await generateReplayViewerHtml(replayPath);
    assert.ok(html.includes('test-flow'), 'should render flow name in header');
    assert.ok(/Duration:/.test(html), 'should render duration label');
    assert.ok(/Events:/.test(html), 'should render event count label');
    assert.ok(/0.5x|1x|2x|4x/.test(html), 'should expose speed controls');
    assert.ok(/Skip inactivity/i.test(html), 'should expose skip-inactivity toggle');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('generateReplayViewerHtml rejects invalid replay files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-viewer-'));
  try {
    const badPath = path.join(dir, 'bad.json');
    await fs.writeFile(badPath, JSON.stringify({ notEvents: true }));
    await assert.rejects(() => generateReplayViewerHtml(badPath), /Invalid replay/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('generateReplayViewerHtml accepts pre-parsed replay via options', async () => {
  const html = await generateReplayViewerHtml('/dev/null', {
    replay: {
      events: [{ type: 4, data: {}, timestamp: 1 }, { type: 2, data: {}, timestamp: 2 }],
      version: 1,
      flowName: 'inline',
      startedAt: 0,
      durationMs: 0,
    },
  });
  assert.ok(html.includes('inline'), 'should use provided flow name');
  assert.ok(html.includes('"type":4'));
});
