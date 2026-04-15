import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { InspectResult } from './types.js';
import { diffResults, formatDiff, saveLastRun, loadResult, LAST_RUN_FILE } from './diff-run.js';

function baseResult(overrides: Partial<InspectResult> = {}): InspectResult {
  return {
    url: 'https://example.com',
    startedAt: '2026-04-14T00:00:00.000Z',
    finishedAt: '2026-04-14T00:00:10.000Z',
    durationMs: 10_000,
    flows: [
      { name: 'home', passed: true, steps: [], screenshots: [] },
      { name: 'checkout', passed: true, steps: [], screenshots: [] },
    ],
    passed: true,
    ...overrides,
  };
}

test('diffResults flags new failing flows', () => {
  const before = baseResult();
  const after = baseResult({
    passed: false,
    flows: [
      { name: 'home', passed: true, steps: [], screenshots: [] },
      { name: 'checkout', passed: false, steps: [], screenshots: [], error: 'timeout on button' },
    ],
  });
  const d = diffResults(before, after);
  assert.equal(d.newFailingFlows.length, 1);
  assert.equal(d.newFailingFlows[0]!.name, 'checkout');
  assert.match(d.newFailingFlows[0]!.error ?? '', /timeout/);
  assert.equal(d.fixedFlows.length, 0);
  assert.equal(d.totalRegressions, 1);
});

test('diffResults flags fixed flows', () => {
  const before = baseResult({
    passed: false,
    flows: [
      { name: 'home', passed: true, steps: [], screenshots: [] },
      { name: 'checkout', passed: false, steps: [], screenshots: [], error: 'boom' },
    ],
  });
  const after = baseResult();
  const d = diffResults(before, after);
  assert.equal(d.fixedFlows.length, 1);
  assert.equal(d.fixedFlows[0]!.name, 'checkout');
  assert.equal(d.totalImprovements, 1);
  assert.equal(d.totalRegressions, 0);
});

test('diffResults computes coverage delta', () => {
  const before = baseResult({
    explore: {
      pagesVisited: 1,
      buttonsClicked: 5,
      formsSubmitted: 0,
      errors: [],
      consoleErrors: [],
      networkErrors: [],
      coverage: { clicked: 5, total: 10, percent: 50, byTag: {}, missed: [] },
    },
  });
  const after = baseResult({
    explore: {
      pagesVisited: 1,
      buttonsClicked: 7,
      formsSubmitted: 0,
      errors: [],
      consoleErrors: [],
      networkErrors: [],
      coverage: { clicked: 7, total: 10, percent: 70, byTag: {}, missed: [] },
    },
  });
  const d = diffResults(before, after);
  assert.equal(d.coverage.beforePercent, 50);
  assert.equal(d.coverage.afterPercent, 70);
  assert.equal(d.coverage.percentDelta, 20);
});

test('diffResults computes perf score deltas by page', () => {
  const page = 'https://example.com';
  const before = baseResult({
    perf: [
      {
        page,
        scores: { performance: 80, accessibility: 90, bestPractices: 95, seo: 100 },
        metrics: { lcp: 2000, fcp: 1000, cls: 0.05, tbt: 100, si: 2500 },
      },
    ],
  });
  const after = baseResult({
    perf: [
      {
        page,
        scores: { performance: 70, accessibility: 92, bestPractices: 95, seo: 100 },
        metrics: { lcp: 2500, fcp: 1100, cls: 0.05, tbt: 100, si: 2500 },
      },
    ],
  });
  const d = diffResults(before, after);
  const perfReg = d.scoreRegressions.find((s) => s.metric === 'performance');
  assert.ok(perfReg);
  assert.equal(perfReg!.delta, -10);
  const a11yImp = d.scoreImprovements.find((s) => s.metric === 'accessibility');
  assert.ok(a11yImp);
  assert.equal(a11yImp!.delta, 2);
});

test('diffResults tracks new/fixed a11y violations per page', () => {
  const page = 'https://example.com';
  const before = baseResult({
    a11y: [
      {
        page,
        passed: false,
        violations: [
          {
            id: 'color-contrast',
            impact: 'serious',
            description: '',
            help: 'fix contrast',
            helpUrl: '',
            nodes: [],
          },
        ],
      },
    ],
  });
  const after = baseResult({
    a11y: [
      {
        page,
        passed: false,
        violations: [
          {
            id: 'label',
            impact: 'critical',
            description: '',
            help: 'add label',
            helpUrl: '',
            nodes: [],
          },
        ],
      },
    ],
  });
  const d = diffResults(before, after);
  assert.equal(d.a11yDeltas.length, 1);
  assert.deepEqual(
    d.a11yDeltas[0]!.newViolations.map((v) => v.id),
    ['label'],
  );
  assert.deepEqual(
    d.a11yDeltas[0]!.fixedViolations.map((v) => v.id),
    ['color-contrast'],
  );
});

test('formatDiff produces human-readable output without color when disabled', () => {
  const before = baseResult();
  const after = baseResult({
    passed: false,
    flows: [
      { name: 'home', passed: true, steps: [], screenshots: [] },
      { name: 'checkout', passed: false, steps: [], screenshots: [], error: 'boom' },
    ],
  });
  const text = formatDiff(diffResults(before, after), { color: false });
  assert.match(text, /uxinspect diff/);
  assert.match(text, /NEW FAIL/);
  assert.match(text, /checkout/);
  // No ANSI escapes when color is off.
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(text, /\x1b\[/);
});

test('formatDiff includes ANSI sequences when color is on', () => {
  const before = baseResult();
  const after = baseResult({
    passed: false,
    flows: [
      { name: 'home', passed: true, steps: [], screenshots: [] },
      { name: 'checkout', passed: false, steps: [], screenshots: [] },
    ],
  });
  const text = formatDiff(diffResults(before, after), { color: true });
  // eslint-disable-next-line no-control-regex
  assert.match(text, /\x1b\[/);
});

test('saveLastRun writes .uxinspect/last.json and loadResult round-trips', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-diff-'));
  const r = baseResult();
  const written = await saveLastRun(r, tmp);
  assert.equal(written, path.join(tmp, LAST_RUN_FILE));
  const loaded = await loadResult(written);
  assert.equal(loaded.url, r.url);
  assert.equal(loaded.flows.length, r.flows.length);
  await fs.rm(tmp, { recursive: true });
});

test('diffResults detects no-op runs', () => {
  const before = baseResult();
  const after = baseResult();
  const d = diffResults(before, after);
  assert.equal(d.totalRegressions, 0);
  assert.equal(d.totalImprovements, 0);
  const text = formatDiff(d, { color: false });
  assert.match(text, /No measurable differences/);
});
