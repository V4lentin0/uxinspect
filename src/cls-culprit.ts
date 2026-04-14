import type { Page } from 'playwright';

export interface RectLite {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ShiftSource {
  selector: string;
  currentRect: RectLite;
  previousRect: RectLite;
  shiftDistance: number;
}

export interface ShiftEntry {
  value: number;
  startTime: number;
  hadRecentInput: boolean;
  sources: ShiftSource[];
}

export interface ClsCulpritResult {
  page: string;
  cls: number;
  shifts: ShiftEntry[];
  topCulprits: { selector: string; contribution: number; count: number }[];
  hints: string[];
  passed: boolean;
}

export interface ClsCulpritOptions {
  durationMs?: number;
}

interface RawSource {
  selector: string;
  tagName: string;
  hasWidthAttr: boolean;
  hasHeightAttr: boolean;
  position: string;
  className: string;
  currentRect: RectLite;
  previousRect: RectLite;
  shiftDistance: number;
}

interface RawShift {
  value: number;
  startTime: number;
  hadRecentInput: boolean;
  sources: RawSource[];
}

interface ClsWindow extends Window {
  __uxi_cls_culprit?: RawShift[];
}

export async function auditClsCulprit(
  page: Page,
  opts: ClsCulpritOptions = {},
): Promise<ClsCulpritResult> {
  const durationMs = opts.durationMs ?? 5000;

  await page.addInitScript(() => {
    const w = window as Window & { __uxi_cls_culprit?: RawShift[] };
    if (w.__uxi_cls_culprit) return;
    w.__uxi_cls_culprit = [];

    interface RectLite {
      x: number;
      y: number;
      width: number;
      height: number;
    }
    interface RawSource {
      selector: string;
      tagName: string;
      hasWidthAttr: boolean;
      hasHeightAttr: boolean;
      position: string;
      className: string;
      currentRect: RectLite;
      previousRect: RectLite;
      shiftDistance: number;
    }
    interface RawShift {
      value: number;
      startTime: number;
      hadRecentInput: boolean;
      sources: RawSource[];
    }

    function buildSelector(node: Element | null): string {
      if (!node) return '(anonymous)';
      if (node.id) return '#' + node.id;
      const testId = node.getAttribute('data-testid');
      if (testId) return '[data-testid="' + testId + '"]';
      const tag = node.tagName ? node.tagName.toLowerCase() : 'node';
      const classAttr = node.getAttribute('class') || '';
      const classes = classAttr
        .split(/\s+/)
        .filter((c) => c.length > 0)
        .slice(0, 2)
        .join('.');
      let base = tag + (classes ? '.' + classes : '');
      const parent = node.parentElement;
      if (parent && !node.id && parent.tagName) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === node.tagName,
        );
        if (siblings.length > 1) {
          const idx = siblings.indexOf(node);
          if (idx >= 0) base += ':nth-of-type(' + (idx + 1) + ')';
        }
      }
      return base;
    }

    function rectLite(r: DOMRectReadOnly | undefined | null): RectLite {
      if (!r) return { x: 0, y: 0, width: 0, height: 0 };
      return {
        x: r.x || 0,
        y: r.y || 0,
        width: r.width || 0,
        height: r.height || 0,
      };
    }

    function resolveElement(n: unknown): Element | null {
      if (!n) return null;
      const node = n as Node;
      if (node.nodeType === 1) return node as Element;
      if (node.nodeType === 3 && node.parentElement) return node.parentElement;
      return null;
    }

    try {
      const po = new PerformanceObserver((list) => {
        const store = w.__uxi_cls_culprit;
        if (!store) return;
        for (const entry of list.getEntries()) {
          const e = entry as PerformanceEntry & {
            value: number;
            hadRecentInput: boolean;
            sources?: Array<{
              node: unknown;
              previousRect: DOMRectReadOnly;
              currentRect: DOMRectReadOnly;
            }>;
          };
          const rawSources: RawSource[] = [];
          const srcArr = e.sources || [];
          for (const s of srcArr) {
            const el = resolveElement(s.node);
            const prev = rectLite(s.previousRect);
            const curr = rectLite(s.currentRect);
            const shiftDistance =
              Math.abs(curr.x - prev.x) + Math.abs(curr.y - prev.y);
            let tagName = '';
            let hasWidthAttr = false;
            let hasHeightAttr = false;
            let position = '';
            let className = '';
            if (el) {
              tagName = el.tagName || '';
              hasWidthAttr = el.hasAttribute('width');
              hasHeightAttr = el.hasAttribute('height');
              className = (el.getAttribute('class') || '').toLowerCase();
              try {
                position = getComputedStyle(el).position || '';
              } catch {
                position = '';
              }
            }
            rawSources.push({
              selector: buildSelector(el),
              tagName,
              hasWidthAttr,
              hasHeightAttr,
              position,
              className,
              currentRect: curr,
              previousRect: prev,
              shiftDistance,
            });
          }
          store.push({
            value: e.value,
            startTime: e.startTime,
            hadRecentInput: e.hadRecentInput,
            sources: rawSources,
          });
        }
      });
      po.observe({ type: 'layout-shift', buffered: true });
    } catch {
      // PerformanceObserver unsupported; leave store empty
    }
  });

  await page.waitForTimeout(durationMs);

  const raw: RawShift[] = await page.evaluate(() => {
    const w = window as unknown as ClsWindow;
    return w.__uxi_cls_culprit ?? [];
  });

  const shifts: ShiftEntry[] = raw.map((s) => ({
    value: s.value,
    startTime: s.startTime,
    hadRecentInput: s.hadRecentInput,
    sources: s.sources.map((src) => ({
      selector: src.selector,
      currentRect: src.currentRect,
      previousRect: src.previousRect,
      shiftDistance: src.shiftDistance,
    })),
  }));

  const cls = shifts.reduce((sum, s) => sum + (s.hadRecentInput ? 0 : s.value), 0);

  const contribMap = new Map<string, { contribution: number; count: number }>();
  for (const s of raw) {
    if (s.hadRecentInput) continue;
    const n = s.sources.length || 1;
    const perSource = s.value / n;
    for (const src of s.sources) {
      const prev = contribMap.get(src.selector) ?? { contribution: 0, count: 0 };
      contribMap.set(src.selector, {
        contribution: prev.contribution + perSource,
        count: prev.count + 1,
      });
    }
  }

  const topCulprits = [...contribMap.entries()]
    .map(([selector, stats]) => ({
      selector,
      contribution: stats.contribution,
      count: stats.count,
    }))
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 10);

  const hints = collectHints(raw);

  return {
    page: page.url(),
    cls,
    shifts,
    topCulprits,
    hints,
    passed: cls <= 0.1,
  };
}

function collectHints(raw: RawShift[]): string[] {
  const out = new Set<string>();
  const fontHeavyTags = new Set(['H1', 'H2', 'H3', 'H4', 'P', 'SPAN', 'A', 'DIV']);
  for (const s of raw) {
    if (s.hadRecentInput) continue;
    for (const src of s.sources) {
      const tag = src.tagName.toUpperCase();
      if ((tag === 'IMG' || tag === 'IFRAME') && (!src.hasWidthAttr || !src.hasHeightAttr)) {
        out.add(
          'add explicit width & height attributes to <' +
            tag.toLowerCase() +
            '> elements (e.g., ' +
            src.selector +
            ')',
        );
      }
      if (tag === 'VIDEO') {
        out.add(
          'set aspect-ratio or poster dimensions on <video> (e.g., ' + src.selector + ')',
        );
      }
      if (
        src.currentRect.y < 100 &&
        fontHeavyTags.has(tag) &&
        src.shiftDistance > 0
      ) {
        out.add('preload fonts + use font-display: optional to prevent top-of-page text reflow');
      }
      if (src.position === 'absolute' && src.shiftDistance > 0) {
        out.add(
          'avoid animating top/left on position:absolute elements; use transform instead (e.g., ' +
            src.selector +
            ')',
        );
      }
      const cls = src.className;
      if (
        cls.includes('ad') ||
        cls.includes('banner') ||
        cls.includes('cookie') ||
        cls.includes('consent') ||
        cls.includes('promo')
      ) {
        out.add(
          'reserve space with min-height for dynamically injected elements (e.g., ' +
            src.selector +
            ')',
        );
      }
    }
  }
  return [...out];
}
