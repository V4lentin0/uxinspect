import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PNG } from 'pngjs';
import { renderCrossBrowserHtml } from './cross-browser.js';
import type { CrossBrowserReport } from './cross-browser.js';
import { writeReport } from './report.js';
import type { InspectResult } from './types.js';

async function writePng(filePath: string, width = 4, height = 4): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 0;
    png.data[i + 1] = 128;
    png.data[i + 2] = 64;
    png.data[i + 3] = 255;
  }
  await fs.writeFile(filePath, PNG.sync.write(png));
}

async function buildFixture(dir: string): Promise<CrossBrowserReport> {
  const engines: CrossBrowserReport['engines'] = ['chromium', 'firefox', 'webkit'];
  for (const e of engines) {
    await writePng(path.join(dir, e, 'report', 'current', 'load-desktop.png'));
  }
  const diffDir = path.join(dir, 'diffs');
  await fs.mkdir(path.join(diffDir, 'chromium-vs-firefox'), { recursive: true });
  await fs.mkdir(path.join(diffDir, 'chromium-vs-webkit'), { recursive: true });
  await fs.mkdir(path.join(diffDir, 'firefox-vs-webkit'), { recursive: true });
  const cfDiff = path.join(diffDir, 'chromium-vs-firefox', 'load-desktop.png');
  const cwDiff = path.join(diffDir, 'chromium-vs-webkit', 'load-desktop.png');
  const fwDiff = path.join(diffDir, 'firefox-vs-webkit', 'load-desktop.png');
  await writePng(cfDiff);
  await writePng(cwDiff);
  await writePng(fwDiff);

  const report: CrossBrowserReport = {
    url: 'https://example.com',
    engines,
    outcomes: [
      { engine: 'chromium', passed: true, durationMs: 1200, perfLcp: 1500, perfCls: 0.02,
        a11yCriticals: 0, visualDiffs: 0, consoleErrorCount: 0 },
      { engine: 'firefox', passed: true, durationMs: 1800, perfLcp: 1700, perfCls: 0.03,
        a11yCriticals: 0, visualDiffs: 1, consoleErrorCount: 0 },
      { engine: 'webkit', passed: false, durationMs: 2100, perfLcp: 2600, perfCls: 0.12,
        a11yCriticals: 2, visualDiffs: 3, consoleErrorCount: 1,
        error: 'flow "checkout" failed on webkit' },
    ],
    screenshotDiffs: [
      { engineA: 'chromium', engineB: 'firefox', flow: 'load', viewport: 'desktop',
        diffRatio: 0.0125, diffPixels: 42, diffPath: cfDiff },
      { engineA: 'chromium', engineB: 'webkit', flow: 'load', viewport: 'desktop',
        diffRatio: 0.083, diffPixels: 256, diffPath: cwDiff },
      { engineA: 'firefox', engineB: 'webkit', flow: 'load', viewport: 'desktop',
        diffRatio: 0.079, diffPixels: 241, diffPath: fwDiff },
    ],
    metricDeltas: [],
    divergent: ['flow load @ desktop: passed on chromium+firefox, failed on webkit'],
    passed: false,
    outDir: dir,
  };
  return report;
}

test('renderCrossBrowserHtml returns 3-column matrix with diff toggle buttons', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-xb-'));
  try {
    const report = await buildFixture(dir);
    const html = renderCrossBrowserHtml(report, dir);

    // Section wrapper + heading
    assert.match(html, /class="xb-root"/);
    assert.match(html, /Cross-browser matrix/);

    // All three engine columns present
    assert.match(html, /chromium/);
    assert.match(html, /firefox/);
    assert.match(html, /webkit/);

    // 3-column header row (engine column headers in matrix)
    const matrixHeaderCount = (html.match(/<th>chromium<\/th>/g) ?? []).length;
    assert.ok(matrixHeaderCount >= 1, 'chromium column header missing');
    const firefoxHeaderCount = (html.match(/<th>firefox<\/th>/g) ?? []).length;
    assert.ok(firefoxHeaderCount >= 1, 'firefox column header missing');
    const webkitHeaderCount = (html.match(/<th>webkit<\/th>/g) ?? []).length;
    assert.ok(webkitHeaderCount >= 1, 'webkit column header missing');

    // Inline base64 PNG data URIs embedded
    assert.match(html, /data:image\/png;base64,/);

    // Diff toggle buttons for all 3 engine pairs
    assert.match(html, /chromium vs firefox/);
    assert.match(html, /chromium vs webkit/);
    assert.match(html, /firefox vs webkit/);
    const diffBtnCount = (html.match(/class="xb-btn xb-diff-btn"/g) ?? []).length;
    assert.equal(diffBtnCount, 3, 'expected 3 diff toggle buttons');

    // Opacity slider present
    assert.match(html, /type="range"/);
    assert.match(html, /class="xb-slider"/);
    assert.match(html, /overlay opacity/);

    // Per-flow status + pass/fail pills
    assert.match(html, /xb-pass/);
    assert.match(html, /xb-fail/);

    // Divergence line rendered
    assert.match(html, /failed on webkit/);

    // Overall status FAIL since webkit failed
    assert.match(html, /FAIL/);

    // Engine summary table columns
    assert.match(html, /<th>Engine<\/th>/);
    assert.match(html, /<th>LCP<\/th>/);
    assert.match(html, /<th>CLS<\/th>/);
    assert.match(html, /<th>A11y crit<\/th>/);

    // No emojis (design rule)
    // eslint-disable-next-line no-misleading-character-class
    const hasEmoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html);
    assert.equal(hasEmoji, false, 'HTML must not contain emojis');

    // Error message surfaced
    assert.match(html, /flow &quot;checkout&quot; failed on webkit/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('renderCrossBrowserHtml embeds screenshots and diff PNGs inline', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-xb-'));
  try {
    const report = await buildFixture(dir);
    const html = renderCrossBrowserHtml(report, dir);
    // Base images: one per engine (3) + 3 diff images bound to buttons
    const baseImgCount = (html.match(/class="xb-base"/g) ?? []).length;
    assert.equal(baseImgCount, 3, 'expected 3 base screenshots (one per engine)');
    const diffImgCount = (html.match(/class="xb-diff"/g) ?? []).length;
    assert.equal(diffImgCount, 3, 'expected 3 diff image slots (one per engine cell)');
    // All 3 diff button data-diff attributes carry base64 payload
    const dataDiffMatches = html.match(/data-diff="data:image\/png;base64,[^"]+"/g) ?? [];
    assert.equal(dataDiffMatches.length, 3, 'expected 3 diff buttons with inline diff PNGs');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('renderCrossBrowserHtml gracefully handles missing screenshot files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-xb-'));
  try {
    const report: CrossBrowserReport = {
      url: 'https://example.com',
      engines: ['chromium', 'firefox', 'webkit'],
      outcomes: [
        { engine: 'chromium', passed: true, durationMs: 1000, a11yCriticals: 0, visualDiffs: 0, consoleErrorCount: 0 },
        { engine: 'firefox', passed: true, durationMs: 1100, a11yCriticals: 0, visualDiffs: 0, consoleErrorCount: 0 },
        { engine: 'webkit', passed: true, durationMs: 1200, a11yCriticals: 0, visualDiffs: 0, consoleErrorCount: 0 },
      ],
      screenshotDiffs: [],
      metricDeltas: [],
      divergent: [],
      passed: true,
      outDir: dir,
    };
    const html = renderCrossBrowserHtml(report, dir);
    assert.match(html, /screenshot unavailable/);
    assert.match(html, /No divergences detected/);
    assert.match(html, /PASS/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('writeReport includes cross-browser section when crossBrowser present', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-xb-'));
  try {
    const report = await buildFixture(dir);
    const result: InspectResult = {
      url: 'https://example.com',
      startedAt: '2026-04-14T00:00:00.000Z',
      finishedAt: '2026-04-14T00:00:05.000Z',
      durationMs: 5000,
      flows: [{ name: 'load', passed: true, steps: [], screenshots: [] }],
      crossBrowser: report,
      passed: false,
    };
    const reportDir = path.join(dir, 'html-report');
    await fs.mkdir(reportDir, { recursive: true });
    await writeReport(result, reportDir);
    const html = await fs.readFile(path.join(reportDir, 'report.html'), 'utf8');
    assert.match(html, /Cross-browser/);
    assert.match(html, /xb-root/);
    assert.match(html, /chromium vs firefox/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
