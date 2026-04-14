import type { Page } from 'playwright';

export interface DOMRectReadOnlyLite { x: number; y: number; width: number; height: number }

export interface LayoutShiftSample {
  time: number;
  value: number;
  hadRecentInput: boolean;
  sources: { selector: string; preRect: DOMRectReadOnlyLite; currRect: DOMRectReadOnlyLite }[];
}

export interface CLSTimelineResult {
  page: string;
  cls: number;
  worstElements: { selector: string; totalShift: number; occurrences: number }[];
  timeline: LayoutShiftSample[];
  passed: boolean;
}

export async function captureClsTimeline(page: Page, durationMs = 5000): Promise<CLSTimelineResult> {
  await page.evaluate(() => {
    (window as any).__uxi_cls = [];

    function selFor(node: any): string {
      if (!node) return '(none)';
      if (node.id) return '#' + node.id;
      const t = node.getAttribute?.('data-testid');
      if (t) return '[' + 'data-testid' + '="' + t + '"]';
      const cls = (node.className || '').toString().split(' ').filter(Boolean).slice(0, 2).join('.');
      return (node.tagName || 'node').toLowerCase() + (cls ? '.' + cls : '');
    }

    function rectLite(r: any): DOMRectReadOnlyLite {
      return { x: r?.x || 0, y: r?.y || 0, width: r?.width || 0, height: r?.height || 0 };
    }

    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as any[]) {
        const shift = {
          time: e.startTime,
          value: e.value,
          hadRecentInput: e.hadRecentInput,
          sources: (e.sources || []).map((s: any) => ({
            selector: selFor(s.node),
            preRect: rectLite(s.previousRect),
            currRect: rectLite(s.currentRect),
          })),
        };
        (window as any).__uxi_cls.push(shift);
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });

  await new Promise<void>((resolve) => setTimeout(resolve, durationMs));

  const timeline: LayoutShiftSample[] = await page.evaluate(() => (window as any).__uxi_cls ?? []);

  const cls = timeline.reduce((sum, s) => sum + (s.hadRecentInput ? 0 : s.value), 0);

  const totals = new Map<string, { totalShift: number; occurrences: number }>();
  for (const sample of timeline) {
    if (sample.hadRecentInput) continue;
    for (const src of sample.sources) {
      const prev = totals.get(src.selector) ?? { totalShift: 0, occurrences: 0 };
      totals.set(src.selector, {
        totalShift: prev.totalShift + sample.value,
        occurrences: prev.occurrences + 1,
      });
    }
  }

  const worstElements = [...totals.entries()]
    .map(([selector, stats]) => ({ selector, ...stats }))
    .sort((a, b) => b.totalShift - a.totalShift)
    .slice(0, 5);

  return {
    page: page.url(),
    cls,
    worstElements,
    timeline,
    passed: cls < 0.1,
  };
}
