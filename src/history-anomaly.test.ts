import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAnomalies, renderHistoryHtml } from './history-timeline.js';
import type { HistoryRun, Anomaly } from './history-timeline.js';
import type { InspectResult } from './types.js';

// Build a synthetic run where every relevant metric is parametrised so we can
// seed a stable baseline of identical runs, then inject a single outlier at
// the tail. Numbers are chosen so stdDev on the baseline is ~0 except where
// the test explicitly widens it.
function makeRun(opts: {
  i: number;
  perfScore?: number;
  a11yScore?: number;
  durationMs?: number;
  consoleErrors?: number;
  networkFailures?: number;
  visualDiffPixels?: number;
  clicks?: number;
}): HistoryRun {
  const {
    i,
    perfScore = 90,
    a11yScore = 95,
    durationMs = 5000,
    consoleErrors = 0,
    networkFailures = 0,
    visualDiffPixels = 0,
    clicks = 0,
  } = opts;
  const startedAt = new Date(Date.UTC(2026, 0, 1, 0, i, 0)).toISOString();
  const finishedAt = new Date(Date.UTC(2026, 0, 1, 0, i, 5)).toISOString();
  const result: InspectResult = {
    url: 'https://example.com',
    startedAt,
    finishedAt,
    durationMs,
    flows: [
      {
        name: 'primary',
        passed: true,
        screenshots: [],
        steps: [
          // Mix click / hover / check so countFlowClicks can stage the total.
          ...Array.from({ length: Math.max(0, clicks) }, () => ({
            step: { click: '#btn' },
            passed: true,
            durationMs: 10,
            networkFailures: [] as import('./network-attribution.js').NetworkFailure[],
          })),
          // Park network failures on an anchor step so extractNetworkFailures
          // has a single aggregation target.
          {
            step: { goto: 'https://example.com' },
            passed: true,
            durationMs: 10,
            networkFailures: Array.from({ length: networkFailures }, (_, k) => ({
              url: `https://x/${k}`,
              status: 500,
              method: 'GET',
              timestamp: Date.now(),
            })),
          },
        ],
      },
    ],
    perf: [
      {
        page: 'home',
        scores: { performance: perfScore, accessibility: a11yScore, bestPractices: 90, seo: 92 },
        metrics: { lcp: 2000, cls: 0.01, tbt: 100, fcp: 800, si: 1400 },
      },
    ],
    a11y: [],
    visual: Array.from({ length: visualDiffPixels > 0 ? 1 : 0 }, () => ({
      page: 'home',
      viewport: 'desktop',
      baseline: 'b.png',
      current: 'c.png',
      diffPixels: visualDiffPixels,
      diffRatio: 0,
      passed: true,
    })),
    consoleErrors: Array.from({ length: consoleErrors }, (_, k) => ({
      page: 'home',
      issues: [],
      errorCount: 1,
      warningCount: 0,
      passed: false,
      _k: k,
    })) as unknown as InspectResult['consoleErrors'],
    passed: true,
  };
  return { path: `mem://run/${i}`, result };
}

// 1. Flat baseline + single regression outlier on performance score.
test('computeAnomalies flags a regression on perf score', () => {
  const runs: HistoryRun[] = [];
  // 10 stable baseline runs (perf=90 plus small symmetric noise so std != 0).
  for (let i = 0; i < 10; i++) {
    runs.push(makeRun({ i, perfScore: 90 + (i % 2 === 0 ? 1 : -1) }));
  }
  // Outlier at the end: big drop to 40.
  runs.push(makeRun({ i: 10, perfScore: 40 }));

  const anomalies = computeAnomalies(runs);
  const perfAnoms = anomalies.filter((a: Anomaly) => a.metric === 'perf.score');
  assert.ok(perfAnoms.length >= 1, 'at least one perf anomaly detected');
  const tail = perfAnoms.find((a: Anomaly) => a.runIndex === 10);
  assert.ok(tail, 'outlier at runIndex 10 was flagged');
  assert.equal(tail!.direction, 'regression');
  assert.ok(tail!.zScore < -2, `expected z < -2, got ${tail!.zScore}`);
  assert.equal(tail!.runId, 'mem://run/10');
});

// 2. Improvement on accessibility score (big jump up).
test('computeAnomalies flags an improvement on a11y score when z > +threshold', () => {
  const runs: HistoryRun[] = [];
  for (let i = 0; i < 10; i++) {
    runs.push(makeRun({ i, a11yScore: 70 + (i % 2 === 0 ? 1 : -1) }));
  }
  runs.push(makeRun({ i: 10, a11yScore: 99 }));

  const anomalies = computeAnomalies(runs);
  const a11yAnoms = anomalies.filter((a: Anomaly) => a.metric === 'a11y.score');
  const tail = a11yAnoms.find((a: Anomaly) => a.runIndex === 10);
  assert.ok(tail, 'outlier at runIndex 10 flagged on a11y');
  assert.equal(tail!.direction, 'improvement');
  assert.ok(tail!.zScore > 2, `expected z > 2, got ${tail!.zScore}`);
});

// 3. Lower-better axes: console error spike is a regression, not an improvement.
test('computeAnomalies flags console-error spike as regression (lower-is-better semantics)', () => {
  const runs: HistoryRun[] = [];
  for (let i = 0; i < 10; i++) {
    runs.push(makeRun({ i, consoleErrors: i % 2 })); // 0,1,0,1,... mean 0.5
  }
  runs.push(makeRun({ i: 10, consoleErrors: 25 }));
  const anomalies = computeAnomalies(runs);
  const tail = anomalies.find((a: Anomaly) => a.metric === 'console.errors' && a.runIndex === 10);
  assert.ok(tail, 'console error anomaly flagged');
  assert.equal(tail!.direction, 'regression');
  assert.ok(tail!.zScore > 2);
});

// 4. Window/threshold options are respected; not-enough-history returns [].
test('computeAnomalies respects window+threshold options and minimum-baseline gating', () => {
  // Only 2 runs → below MIN_BASELINE_SAMPLES floor → empty.
  assert.deepEqual(
    computeAnomalies([makeRun({ i: 0 }), makeRun({ i: 1, perfScore: 10 })]),
    [],
  );

  // Threshold well above the observed z → no anomalies.
  const runs: HistoryRun[] = [];
  for (let i = 0; i < 10; i++) runs.push(makeRun({ i, perfScore: 90 + (i % 2 ? -1 : 1) }));
  runs.push(makeRun({ i: 10, perfScore: 40 })); // big drop
  assert.equal(
    computeAnomalies(runs, { threshold: 50 }).filter((a) => a.metric === 'perf.score').length,
    0,
    'threshold=50 suppresses the regression',
  );

  // Window=3 clips the baseline to the last 3 runs, so a recent flat trend
  // still flags a tail outlier on a smaller window.
  const short: HistoryRun[] = [];
  for (let i = 0; i < 3; i++) short.push(makeRun({ i, perfScore: 90 }));
  short.push(makeRun({ i: 3, perfScore: 90 })); // stabilise stdDev via small jitter
  short.push(makeRun({ i: 4, perfScore: 91 }));
  short.push(makeRun({ i: 5, perfScore: 20 }));
  const shortAnoms = computeAnomalies(short, { window: 3 }).filter((a) => a.metric === 'perf.score');
  assert.ok(shortAnoms.some((a) => a.runIndex === 5 && a.direction === 'regression'));
});

// 5. Flow duration spike flagged as regression; network failures + visual diff also wired.
test('computeAnomalies covers duration / network / visual / click axes', () => {
  const runs: HistoryRun[] = [];
  for (let i = 0; i < 10; i++) {
    runs.push(makeRun({
      i,
      durationMs: 5000 + (i % 2 === 0 ? 50 : -50),
      networkFailures: i % 2,
      visualDiffPixels: 100 + (i % 2 === 0 ? 5 : -5),
      clicks: 10 + (i % 2 === 0 ? 1 : -1),
    }));
  }
  // One tail run perturbs every lower-better axis upward and the click count
  // downward — each should surface as its own anomaly.
  runs.push(makeRun({
    i: 10,
    durationMs: 60000,
    networkFailures: 50,
    visualDiffPixels: 100000,
    clicks: 0,
  }));

  const anomalies = computeAnomalies(runs);
  const axisHit = (metric: string, direction: 'regression' | 'improvement') =>
    anomalies.some((a) => a.metric === metric && a.runIndex === 10 && a.direction === direction);

  assert.ok(axisHit('flow.duration', 'regression'), 'duration regression flagged');
  assert.ok(axisHit('network.failures', 'regression'), 'network failures regression flagged');
  assert.ok(axisHit('visual.diff.total', 'regression'), 'visual diff regression flagged');
  assert.ok(axisHit('click.count', 'regression'), 'click-count drop flagged as regression');
});

// 6. Graph rendering: SVG contains anomaly ring elements for flagged runs.
test('renderHistoryHtml paints anomaly rings in the trend graph SVG', () => {
  const runs: HistoryRun[] = [];
  for (let i = 0; i < 10; i++) runs.push(makeRun({ i, perfScore: 90 + (i % 2 === 0 ? 1 : -1) }));
  runs.push(makeRun({ i: 10, perfScore: 35 }));
  const html = renderHistoryHtml(runs, { title: 'anomaly test', maxRuns: 30 });
  // Regression rings use the red stroke #EF4444 and class anomaly-regression.
  assert.match(html, /class="anomaly anomaly-regression"/);
  assert.match(html, /stroke="#EF4444"/);
  assert.match(html, /<title>regression \(z=/);
});
