import type { Page } from 'playwright';

export interface RUMResult {
  page: string;
  lcp?: { value: number; target?: string; size?: number; url?: string };
  cls?: { value: number; worstEntry?: { value: number; target?: string } };
  inp?: { value: number; target?: string; interactionType?: string };
  fcp?: number;
  ttfb?: number;
  fid?: number;
  navigationType?: string;
  deviceMemory?: number;
  hardwareConcurrency?: number;
  effectiveConnectionType?: string;
  passed: boolean;
}

interface RawLCP {
  value: number;
  target?: string;
  size?: number;
  url?: string;
}

interface RawCLS {
  value: number;
  worstEntry?: { value: number; target?: string };
}

interface RawINP {
  value: number;
  target?: string;
  interactionType?: string;
}

interface RawCollector {
  lcp?: RawLCP;
  cls?: RawCLS;
  inp?: RawINP;
  fcp?: number;
  ttfb?: number;
  fid?: number;
  navigationType?: string;
  deviceMemory?: number;
  hardwareConcurrency?: number;
  effectiveConnectionType?: string;
}

export async function collectRUM(page: Page, opts: { durationMs?: number } = {}): Promise<RUMResult> {
  const durationMs = opts.durationMs ?? 5000;

  await page.evaluate(() => {
    interface LCPEntry extends PerformanceEntry {
      startTime: number;
      element?: Element | null;
      size?: number;
      url?: string;
    }
    interface CLSEntry extends PerformanceEntry {
      value: number;
      hadRecentInput: boolean;
      sources?: { node?: Element | null }[];
    }
    interface EventEntry extends PerformanceEntry {
      interactionId?: number;
      duration: number;
      target?: Element | null;
      name: string;
    }
    interface FirstInputEntry extends PerformanceEntry {
      processingStart: number;
      startTime: number;
    }

    const selectorOf = (el?: Element | null): string | undefined => {
      if (!el) return undefined;
      let sel = el.tagName.toLowerCase();
      if (el.id) sel += `#${el.id}`;
      const firstClass = el.classList?.[0];
      if (firstClass) sel += `.${firstClass}`;
      return sel;
    };

    const w = window as unknown as { __uxi_rum: RawCollector };
    w.__uxi_rum = {};
    const state = w.__uxi_rum;

    try {
      new PerformanceObserver((list) => {
        const entries = list.getEntries() as LCPEntry[];
        if (entries.length === 0) return;
        const last = entries[entries.length - 1];
        state.lcp = {
          value: last.startTime,
          target: selectorOf(last.element),
          size: last.size,
          url: last.url,
        };
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (_) { /* unsupported */ }

    try {
      let clsValue = 0;
      let worst: { value: number; target?: string } | undefined;
      new PerformanceObserver((list) => {
        const entries = list.getEntries() as CLSEntry[];
        entries.forEach((e) => {
          if (e.hadRecentInput) return;
          clsValue += e.value;
          if (!worst || e.value > worst.value) {
            const node = e.sources?.[0]?.node ?? null;
            worst = { value: e.value, target: selectorOf(node) };
          }
        });
        state.cls = { value: clsValue, worstEntry: worst };
      }).observe({ type: 'layout-shift', buffered: true });
    } catch (_) { /* unsupported */ }

    try {
      let worstEvent: { value: number; target?: string; interactionType?: string } | undefined;
      new PerformanceObserver((list) => {
        const entries = list.getEntries() as EventEntry[];
        entries.forEach((e) => {
          if (!e.interactionId) return;
          if (!worstEvent || e.duration > worstEvent.value) {
            worstEvent = {
              value: e.duration,
              target: selectorOf(e.target),
              interactionType: e.name,
            };
          }
        });
        if (worstEvent) state.inp = worstEvent;
      }).observe({ type: 'event', durationThreshold: 40, buffered: true } as PerformanceObserverInit);
    } catch (_) { /* unsupported */ }

    try {
      new PerformanceObserver((list) => {
        list.getEntries().forEach((e) => {
          if (e.name === 'first-contentful-paint') {
            state.fcp = e.startTime;
          }
        });
      }).observe({ type: 'paint', buffered: true });
    } catch (_) { /* unsupported */ }

    try {
      new PerformanceObserver((list) => {
        const entries = list.getEntries() as FirstInputEntry[];
        if (entries.length === 0) return;
        const first = entries[0];
        state.fid = first.processingStart - first.startTime;
      }).observe({ type: 'first-input', buffered: true });
    } catch (_) { /* unsupported */ }

    try {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (nav) {
        state.ttfb = nav.responseStart;
        state.navigationType = nav.type;
      }
    } catch (_) { /* unsupported */ }

    try {
      const n = navigator as Navigator & {
        deviceMemory?: number;
        connection?: { effectiveType?: string };
      };
      state.deviceMemory = n.deviceMemory;
      state.hardwareConcurrency = n.hardwareConcurrency;
      state.effectiveConnectionType = n.connection?.effectiveType;
    } catch (_) { /* unsupported */ }
  });

  await page.waitForTimeout(durationMs);

  const raw: RawCollector = await page.evaluate(
    () => (window as unknown as { __uxi_rum: RawCollector }).__uxi_rum ?? {}
  );

  const lcpValue = raw.lcp?.value;
  const clsValue = raw.cls?.value;
  const inpValue = raw.inp?.value;

  const passed =
    (lcpValue === undefined || lcpValue < 2500) &&
    (clsValue === undefined || clsValue < 0.1) &&
    (inpValue === undefined || inpValue < 200);

  return {
    page: page.url(),
    lcp: raw.lcp,
    cls: raw.cls,
    inp: raw.inp,
    fcp: raw.fcp,
    ttfb: raw.ttfb,
    fid: raw.fid,
    navigationType: raw.navigationType,
    deviceMemory: raw.deviceMemory,
    hardwareConcurrency: raw.hardwareConcurrency,
    effectiveConnectionType: raw.effectiveConnectionType,
    passed,
  };
}

export function rumClientScript(endpoint = '/rum'): string {
  const endpointJson = JSON.stringify(endpoint);
  return `(function(){
  try {
    var endpoint = ${endpointJson};
    var state = { page: location.href };
    var selectorOf = function(el){
      if (!el) return undefined;
      var s = el.tagName.toLowerCase();
      if (el.id) s += '#' + el.id;
      var c = el.classList && el.classList[0];
      if (c) s += '.' + c;
      return s;
    };
    try {
      new PerformanceObserver(function(list){
        var entries = list.getEntries();
        if (!entries.length) return;
        var last = entries[entries.length - 1];
        state.lcp = { value: last.startTime, target: selectorOf(last.element), size: last.size, url: last.url };
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch(_){}
    try {
      var clsValue = 0; var worst;
      new PerformanceObserver(function(list){
        list.getEntries().forEach(function(e){
          if (e.hadRecentInput) return;
          clsValue += e.value;
          if (!worst || e.value > worst.value) {
            var node = e.sources && e.sources[0] && e.sources[0].node;
            worst = { value: e.value, target: selectorOf(node) };
          }
        });
        state.cls = { value: clsValue, worstEntry: worst };
      }).observe({ type: 'layout-shift', buffered: true });
    } catch(_){}
    try {
      var worstEvent;
      new PerformanceObserver(function(list){
        list.getEntries().forEach(function(e){
          if (!e.interactionId) return;
          if (!worstEvent || e.duration > worstEvent.value) {
            worstEvent = { value: e.duration, target: selectorOf(e.target), interactionType: e.name };
          }
        });
        if (worstEvent) state.inp = worstEvent;
      }).observe({ type: 'event', durationThreshold: 40, buffered: true });
    } catch(_){}
    try {
      new PerformanceObserver(function(list){
        list.getEntries().forEach(function(e){
          if (e.name === 'first-contentful-paint') state.fcp = e.startTime;
        });
      }).observe({ type: 'paint', buffered: true });
    } catch(_){}
    try {
      new PerformanceObserver(function(list){
        var entries = list.getEntries();
        if (!entries.length) return;
        var first = entries[0];
        state.fid = first.processingStart - first.startTime;
      }).observe({ type: 'first-input', buffered: true });
    } catch(_){}
    try {
      var nav = performance.getEntriesByType('navigation')[0];
      if (nav) { state.ttfb = nav.responseStart; state.navigationType = nav.type; }
    } catch(_){}
    try {
      state.deviceMemory = navigator.deviceMemory;
      state.hardwareConcurrency = navigator.hardwareConcurrency;
      state.effectiveConnectionType = navigator.connection && navigator.connection.effectiveType;
    } catch(_){}
    var sent = false;
    var beacon = function(){
      if (sent) return; sent = true;
      try {
        var body = JSON.stringify(state);
        if (navigator.sendBeacon) {
          navigator.sendBeacon(endpoint, body);
        } else {
          fetch(endpoint, { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'application/json' } });
        }
      } catch(_){}
    };
    addEventListener('visibilitychange', function(){ if (document.visibilityState === 'hidden') beacon(); });
    addEventListener('pagehide', beacon);
  } catch(_){}
})();`;
}
