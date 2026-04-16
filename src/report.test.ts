import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeReport } from './report.js';
import type { InspectResult } from './types.js';

test('writeReport creates report.json and report.html', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-test-'));
  const result: InspectResult = {
    url: 'https://example.com',
    startedAt: '2026-04-14T00:00:00.000Z',
    finishedAt: '2026-04-14T00:00:01.000Z',
    durationMs: 1000,
    flows: [{ name: 'load', passed: true, steps: [], screenshots: [] }],
    a11y: [{ page: 'https://example.com', violations: [], passed: true }],
    passed: true,
  };
  await writeReport(result, dir);
  const json = JSON.parse(await fs.readFile(path.join(dir, 'report.json'), 'utf8'));
  assert.equal(json.url, 'https://example.com');
  const html = await fs.readFile(path.join(dir, 'report.html'), 'utf8');
  assert.match(html, /PASS/);
  assert.match(html, /example\.com/);
  await fs.rm(dir, { recursive: true });
});

test('writeReport shows FAIL when flow fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-test-'));
  const result: InspectResult = {
    url: 'https://example.com',
    startedAt: '2026-04-14T00:00:00.000Z',
    finishedAt: '2026-04-14T00:00:01.000Z',
    durationMs: 1000,
    flows: [{ name: 'load', passed: false, steps: [], screenshots: [], error: 'boom' }],
    passed: false,
  };
  await writeReport(result, dir);
  const html = await fs.readFile(path.join(dir, 'report.html'), 'utf8');
  assert.match(html, /FAIL/);
  await fs.rm(dir, { recursive: true });
});

test('writeReport renders replay link on failed flow with viewer HTML + seek', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-test-'));
  const viewerPath = path.join(dir, 'replays', 'checkout.html');
  await fs.mkdir(path.dirname(viewerPath), { recursive: true });
  await fs.writeFile(viewerPath, '<html>viewer</html>');
  const result: InspectResult = {
    url: 'https://example.com',
    startedAt: '2026-04-14T00:00:00.000Z',
    finishedAt: '2026-04-14T00:00:01.000Z',
    durationMs: 1000,
    flows: [
      {
        name: 'checkout',
        passed: false,
        steps: [],
        screenshots: [],
        error: 'step 3 failed',
        replayViewerPath: viewerPath,
        replayStartedAt: 1_700_000_000_000,
        failureTimestamp: 1_700_000_002_500,
      },
    ],
    passed: false,
  };
  await writeReport(result, dir);
  const html = await fs.readFile(path.join(dir, 'report.html'), 'utf8');
  assert.match(html, /class="replay-btn"/);
  // href encodes seek offset (2500ms = 2500).
  assert.match(html, /#t=2500/);
  // Seek label shows seconds with 2 decimals.
  assert.match(html, /at 2\.50s/);
  assert.match(html, /Replay failure/);
  await fs.rm(dir, { recursive: true });
});

test('writeReport does NOT render replay link on passed flow', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-test-'));
  const result: InspectResult = {
    url: 'https://example.com',
    startedAt: '2026-04-14T00:00:00.000Z',
    finishedAt: '2026-04-14T00:00:01.000Z',
    durationMs: 1000,
    flows: [
      {
        name: 'ok',
        passed: true,
        steps: [],
        screenshots: [],
        replayPath: path.join(dir, 'replay.json'),
      },
    ],
    passed: true,
  };
  await writeReport(result, dir);
  const html = await fs.readFile(path.join(dir, 'report.html'), 'utf8');
  assert.doesNotMatch(html, /class="replay-btn"/);
  await fs.rm(dir, { recursive: true });
});

test('writeReport falls back to JSON path hint when viewer missing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-test-'));
  const result: InspectResult = {
    url: 'https://example.com',
    startedAt: '2026-04-14T00:00:00.000Z',
    finishedAt: '2026-04-14T00:00:01.000Z',
    durationMs: 1000,
    flows: [
      {
        name: 'login',
        passed: false,
        steps: [],
        screenshots: [],
        error: 'broken',
        replayPath: path.join(dir, 'replays', 'login.json'),
      },
    ],
    passed: false,
  };
  await writeReport(result, dir);
  const html = await fs.readFile(path.join(dir, 'report.html'), 'utf8');
  assert.match(html, /class="replay-btn"/);
  // Hint tells the user to run the CLI since no viewer HTML is pre-built.
  assert.match(html, /uxinspect replay/);
  await fs.rm(dir, { recursive: true });
});

test('writeReport renders Self-heal events section (P2 #26)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-test-'));
  const result: InspectResult = {
    url: 'https://example.com',
    startedAt: '2026-04-14T00:00:00.000Z',
    finishedAt: '2026-04-14T00:00:01.000Z',
    durationMs: 1000,
    flows: [{ name: 'load', passed: true, steps: [], screenshots: [] }],
    selfHealEvents: [
      {
        instruction: 'click Submit order',
        failedSelector: 'css=.submit-btn',
        healedWith: 'testid-neighborhood',
        newSelector: 'testid=submit-form',
        at: Date.parse('2026-04-14T00:00:00.500Z'),
        url: 'https://example.com',
      },
    ],
    passed: true,
  };
  await writeReport(result, dir);
  const html = await fs.readFile(path.join(dir, 'report.html'), 'utf8');
  assert.match(html, /Self-heal events/);
  assert.match(html, /Submit order/);
  assert.match(html, /testid-neighborhood/);
  assert.match(html, /submit-form/);
  await fs.rm(dir, { recursive: true });
});
