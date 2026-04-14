import type { Page } from 'playwright';

export interface InpInteraction {
  type: string;
  target: string;
  inputDelayMs: number;
  processingMs: number;
  presentationDelayMs: number;
  totalMs: number;
  startTime: number;
}

export interface InpAuditResult {
  page: string;
  interactions: InpInteraction[];
  inp: number | null;
  good: boolean;
  needsImprovement: boolean;
  poor: boolean;
  passed: boolean;
}

export interface InpAuditOptions {
  interactSelectors?: string[];
  maxInteractions?: number;
  delayBetweenMs?: number;
}

interface InpRecord {
  type: string;
  target: string;
  inputDelayMs: number;
  processingMs: number;
  presentationDelayMs: number;
  totalMs: number;
  startTime: number;
}

interface DiscoveredTarget {
  selector: string;
  navigates: boolean;
}

const GOOD_THRESHOLD_MS = 200;
const NEEDS_IMPROVEMENT_THRESHOLD_MS = 500;
const DEFAULT_MAX_INTERACTIONS = 10;
const DEFAULT_DELAY_MS = 500;
const DURATION_THRESHOLD_MS = 16;
const P98_MIN_SAMPLES = 50;

export async function auditInp(page: Page, opts: InpAuditOptions = {}): Promise<InpAuditResult> {
  const maxInteractions = opts.maxInteractions ?? DEFAULT_MAX_INTERACTIONS;
  const delayBetweenMs = opts.delayBetweenMs ?? DEFAULT_DELAY_MS;

  await installObserver(page);

  const selectors = opts.interactSelectors && opts.interactSelectors.length > 0
    ? opts.interactSelectors.slice(0, maxInteractions)
    : await discoverInteractables(page, maxInteractions);

  for (const selector of selectors) {
    await page.click(selector, { trial: false, timeout: 2000 }).catch(() => { /* skip failures */ });
    await page.waitForTimeout(delayBetweenMs);
  }

  await page.waitForTimeout(delayBetweenMs);

  const records = await collectRecords(page);

  const interactions: InpInteraction[] = records.map((r) => ({
    type: r.type,
    target: r.target,
    inputDelayMs: Math.max(0, r.inputDelayMs),
    processingMs: Math.max(0, r.processingMs),
    presentationDelayMs: Math.max(0, r.presentationDelayMs),
    totalMs: Math.max(0, r.totalMs),
    startTime: r.startTime,
  }));

  const inp = computeInp(interactions);
  const good = inp !== null && inp <= GOOD_THRESHOLD_MS;
  const poor = inp !== null && inp > NEEDS_IMPROVEMENT_THRESHOLD_MS;
  const needsImprovement = inp !== null && !good && !poor;
  const passed = !poor;

  return {
    page: page.url(),
    interactions,
    inp,
    good,
    needsImprovement,
    poor,
    passed,
  };
}

async function installObserver(page: Page): Promise<void> {
  await page.evaluate((threshold: number) => {
    type WindowWithInp = Window & { __inpRecords?: InpRecord[] };
    interface InpRecord {
      type: string;
      target: string;
      inputDelayMs: number;
      processingMs: number;
      presentationDelayMs: number;
      totalMs: number;
      startTime: number;
    }
    interface EventTimingLike extends PerformanceEntry {
      processingStart: number;
      processingEnd: number;
      target?: Element | null;
      interactionId?: number;
    }

    const w = window as WindowWithInp;
    if (w.__inpRecords) return;
    w.__inpRecords = [];

    const cssPath = (el: Element | null | undefined): string => {
      if (!el) return '';
      const parts: string[] = [];
      let node: Element | null = el;
      let depth = 0;
      while (node && node.nodeType === 1 && depth < 6) {
        let part = node.tagName.toLowerCase();
        if (node.id) {
          part += '#' + node.id;
          parts.unshift(part);
          break;
        }
        const parent: Element | null = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
          if (siblings.length > 1) {
            const idx = siblings.indexOf(node) + 1;
            part += ':nth-of-type(' + idx + ')';
          }
        }
        parts.unshift(part);
        node = parent;
        depth++;
      }
      return parts.join(' > ');
    };

    const handle = (list: PerformanceObserverEntryList): void => {
      const store = w.__inpRecords;
      if (!store) return;
      for (const raw of list.getEntries()) {
        const entry = raw as EventTimingLike;
        const inputDelay = entry.processingStart - entry.startTime;
        const processing = entry.processingEnd - entry.processingStart;
        const presentation = (entry.startTime + entry.duration) - entry.processingEnd;
        const tag = entry.target && entry.target.tagName ? entry.target.tagName.toLowerCase() : '';
        const path = cssPath(entry.target ?? null);
        const target = tag && path ? (path === tag ? tag : path) : (tag || path || '(unknown)');
        store.push({
          type: entry.name,
          target,
          inputDelayMs: inputDelay,
          processingMs: processing,
          presentationDelayMs: presentation,
          totalMs: entry.duration,
          startTime: entry.startTime,
        });
      }
    };

    try {
      const eventObs = new PerformanceObserver(handle);
      eventObs.observe({ type: 'event', durationThreshold: threshold, buffered: true } as PerformanceObserverInit);
    } catch (_err) { /* unsupported */ }

    try {
      const firstInputObs = new PerformanceObserver(handle);
      firstInputObs.observe({ type: 'first-input', buffered: true } as PerformanceObserverInit);
    } catch (_err) { /* unsupported */ }
  }, DURATION_THRESHOLD_MS);
}

async function discoverInteractables(page: Page, max: number): Promise<string[]> {
  const discovered: DiscoveredTarget[] = await page.evaluate((limit: number) => {
    const origin = window.location.origin;
    const selectors: { selector: string; navigates: boolean }[] = [];

    const isVisible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      if (parseFloat(style.opacity || '1') === 0) return false;
      return true;
    };

    const buildSelector = (el: Element): string => {
      if (el.id) return '#' + CSS.escape(el.id);
      const parts: string[] = [];
      let node: Element | null = el;
      let depth = 0;
      while (node && node.nodeType === 1 && depth < 5) {
        let part = node.tagName.toLowerCase();
        const parent: Element | null = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
          if (siblings.length > 1) {
            const idx = siblings.indexOf(node) + 1;
            part += ':nth-of-type(' + idx + ')';
          }
        }
        parts.unshift(part);
        if (node.id) {
          parts[0] = node.tagName.toLowerCase() + '#' + CSS.escape(node.id);
          break;
        }
        node = parent;
        depth++;
      }
      return parts.join(' > ');
    };

    const query = 'button, a[href], [role="button"], [role="menuitem"]';
    const nodes = Array.from(document.querySelectorAll(query));
    for (const node of nodes) {
      if (selectors.length >= limit) break;
      if (!isVisible(node)) continue;
      let navigates = false;
      if (node.tagName === 'A') {
        const href = (node as HTMLAnchorElement).getAttribute('href') || '';
        if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
          try {
            const u = new URL(href, window.location.href);
            if (u.origin !== origin) navigates = true;
            else if (u.pathname !== window.location.pathname) navigates = true;
          } catch (_e) { /* ignore */ }
        }
      }
      if (navigates) continue;
      selectors.push({ selector: buildSelector(node), navigates });
    }
    return selectors;
  }, max);

  return discovered.map((d) => d.selector).filter((s) => s.length > 0);
}

async function collectRecords(page: Page): Promise<InpRecord[]> {
  return page.evaluate((): InpRecord[] => {
    const w = window as Window & { __inpRecords?: InpRecord[] };
    return w.__inpRecords ? w.__inpRecords.slice() : [];
  });
}

function computeInp(interactions: InpInteraction[]): number | null {
  if (interactions.length === 0) return null;
  const durations = interactions.map((i) => i.totalMs).filter((n) => Number.isFinite(n));
  if (durations.length === 0) return null;
  if (durations.length >= P98_MIN_SAMPLES) {
    const sorted = durations.slice().sort((a, b) => a - b);
    const rank = Math.ceil(0.98 * sorted.length) - 1;
    const idx = Math.min(Math.max(rank, 0), sorted.length - 1);
    return sorted[idx];
  }
  return durations.reduce((m, v) => (v > m ? v : m), 0);
}
