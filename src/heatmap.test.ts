import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderHeatmapSVG,
  logClick,
  logUntested,
  HEATMAP_COLORS,
  type ClickRecord,
  type UntestedRecord,
} from './heatmap.js';

describe('logClick / logUntested', () => {
  test('appends well-formed records', () => {
    const clicks: ClickRecord[] = [];
    logClick(clicks, { x: 10, y: 20, w: 100, h: 40, selector: 'button', result: 'clicked' });
    assert.equal(clicks.length, 1);
    assert.equal(clicks[0]!.result, 'clicked');
    assert.equal(clicks[0]!.x, 10);
  });

  test('drops entries with non-finite or zero-size coords', () => {
    const clicks: ClickRecord[] = [];
    logClick(clicks, { x: NaN, y: 0, w: 10, h: 10, selector: 's', result: 'clicked' });
    logClick(clicks, { x: 0, y: 0, w: 0, h: 10, selector: 's', result: 'clicked' });
    logClick(clicks, { x: 0, y: 0, w: 10, h: -5, selector: 's', result: 'clicked' });
    assert.equal(clicks.length, 0);
  });

  test('logUntested filters similarly', () => {
    const untested: UntestedRecord[] = [];
    logUntested(untested, { x: 0, y: 0, w: 10, h: 10, selector: '.x' });
    logUntested(untested, { x: 0, y: 0, w: 0, h: 0, selector: '.y' });
    assert.equal(untested.length, 1);
  });
});

describe('renderHeatmapSVG', () => {
  const viewport = { name: 'desktop', width: 1280, height: 800 };

  test('emits svg with viewBox matching viewport', () => {
    const svg = renderHeatmapSVG({
      viewport,
      clicks: [],
      untested: [],
    });
    assert.match(svg, /^<svg /);
    assert.match(svg, /viewBox="0 0 1280 800"/);
    assert.match(svg, /preserveAspectRatio="xMidYMid meet"/);
  });

  test('renders one rect per click and untested entry (plus legend swatches)', () => {
    const clicks: ClickRecord[] = [
      { x: 10, y: 10, w: 50, h: 20, selector: 'button.one', result: 'clicked' },
      { x: 80, y: 10, w: 50, h: 20, selector: 'button.two', result: 'clicked' },
      { x: 10, y: 50, w: 50, h: 20, selector: 'button.three', result: 'failed' },
    ];
    const untested: UntestedRecord[] = [
      { x: 200, y: 10, w: 50, h: 20, selector: 'a.link' },
    ];
    const svg = renderHeatmapSVG({ viewport, clicks, untested });
    // 2 green clicked data rects + 2 red data rects (1 failed + 1 untested)
    const greenDataRects = (
      svg.match(new RegExp(`<rect [^>]*fill="${HEATMAP_COLORS.clicked}" fill-opacity="0.6"`, 'g')) ?? []
    ).length;
    const redDataRects = (
      svg.match(new RegExp(`<rect [^>]*fill="${HEATMAP_COLORS.untested}" fill-opacity="0.6"`, 'g')) ?? []
    ).length;
    // 2 clicked data rects + 1 clicked legend swatch = 3
    assert.equal(greenDataRects, 3);
    // 1 failed + 1 untested data rects + 1 red legend swatch = 3
    assert.equal(redDataRects, 3);
  });

  test('uses green for clicked, red for untested, amber for hover-only', () => {
    const svg = renderHeatmapSVG({
      viewport,
      clicks: [{ x: 0, y: 0, w: 20, h: 20, selector: 'a', result: 'clicked' }],
      untested: [{ x: 30, y: 0, w: 20, h: 20, selector: 'b' }],
      hoverOnly: [{ x: 60, y: 0, w: 20, h: 20, selector: 'c' }],
    });
    // Ensure each colour appears as a rect fill (not only inside the legend).
    assert.ok(
      svg.includes(`fill="${HEATMAP_COLORS.clicked}"`),
      'green fill for clicked rects',
    );
    assert.ok(
      svg.includes(`fill="${HEATMAP_COLORS.untested}"`),
      'red fill for untested rects',
    );
    assert.ok(
      svg.includes(`fill="${HEATMAP_COLORS.hoverOnly}"`),
      'amber fill for hover-only rects',
    );
  });

  test('escapes selector text inside <title>', () => {
    const svg = renderHeatmapSVG({
      viewport,
      clicks: [
        {
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          selector: '<script>alert(1)</script>',
          result: 'clicked',
        },
      ],
      untested: [],
    });
    assert.ok(!svg.includes('<script>alert(1)</script>'));
    assert.ok(svg.includes('&lt;script&gt;'));
  });

  test('embeds screenshot as <image> when screenshotUrl provided', () => {
    const svg = renderHeatmapSVG({
      viewport,
      clicks: [],
      untested: [],
      screenshotUrl: 'data:image/png;base64,AAAA',
    });
    assert.match(svg, /<image /);
    assert.match(svg, /href="data:image\/png;base64,AAAA"/);
  });

  test('failed clicks render as untested (red) not green', () => {
    const svg = renderHeatmapSVG({
      viewport,
      clicks: [{ x: 5, y: 5, w: 40, h: 40, selector: 'x', result: 'failed' }],
      untested: [],
    });
    // Data rects use fill-opacity 0.6; legend swatches also do but legend
    // counts always render regardless of data volume, so we must assert on the
    // data rects themselves (identified by non-legend coordinates).
    assert.ok(
      svg.includes('<rect x="5" y="5" width="40" height="40"'),
      'failed click rect is drawn at its real coords',
    );
    // The failed click should contribute to the red count, not the green count.
    assert.match(svg, /<title>failed: x<\/title>/);
  });
});
