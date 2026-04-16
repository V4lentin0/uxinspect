import type {
  CollectorEvent,
  ClickEvent,
  PageViewEvent,
  VitalEvent,
  ErrorEvent as UXIErrorEvent,
  NetFailEvent,
  ResolvedConfig,
} from "./types.js";
import { isPrivate, safeText, selectorFor } from "./privacy.js";

export interface Sink { push(ev: CollectorEvent): void }

const LCP_GOOD = 2500, LCP_POOR = 4000;
const INP_GOOD = 200, INP_POOR = 500;
const CLS_GOOD = 0.1, CLS_POOR = 0.25;
const FCP_GOOD = 1800, FCP_POOR = 3000;
const TTFB_GOOD = 800, TTFB_POOR = 1800;

// Map a raw metric value to a Core Web Vitals rating bucket. Exported so
// tests can assert the thresholds directly.
export function rateVital(name: VitalEvent["name"], v: number): VitalEvent["rating"] {
  const pick = (good: number, poor: number) =>
    (v <= good ? "good" : v <= poor ? "ni" : "poor") as VitalEvent["rating"];
  switch (name) {
    case "LCP": return pick(LCP_GOOD, LCP_POOR);
    case "INP": return pick(INP_GOOD, INP_POOR);
    case "CLS": return pick(CLS_GOOD, CLS_POOR);
    case "FCP": return pick(FCP_GOOD, FCP_POOR);
    case "TTFB": return pick(TTFB_GOOD, TTFB_POOR);
  }
}

function base(cfg: ResolvedConfig): { ts: number; url: string; sid: string } {
  return {
    ts: Date.now(),
    url: typeof location !== "undefined" ? location.href : "",
    sid: cfg.sid,
  };
}

// --- page views --------------------------------------------------------

export function installPageView(cfg: ResolvedConfig, sink: Sink): () => void {
  let last = typeof location !== "undefined" ? location.href : "";
  const emit = (ref?: string) => {
    const ev: PageViewEvent = {
      t: "pageview", ...base(cfg),
      title: typeof document !== "undefined" ? document.title : undefined,
      ref,
    };
    sink.push(ev);
  };
  const onRoute = () => {
    const cur = location.href;
    if (cur !== last) {
      const prev = last;
      last = cur;
      emit(prev);
    }
  };

  // Fire initial pageview once DOM is ready.
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => emit(document.referrer || undefined), { once: true });
    } else {
      emit(document.referrer || undefined);
    }
  }

  // SPA navigation hooks.
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function (...a: Parameters<typeof origPush>) {
    const r = origPush.apply(this, a);
    queueMicrotask(onRoute);
    return r;
  };
  history.replaceState = function (...a: Parameters<typeof origReplace>) {
    const r = origReplace.apply(this, a);
    queueMicrotask(onRoute);
    return r;
  };
  window.addEventListener("popstate", onRoute);
  window.addEventListener("hashchange", onRoute);

  return () => {
    history.pushState = origPush;
    history.replaceState = origReplace;
    window.removeEventListener("popstate", onRoute);
    window.removeEventListener("hashchange", onRoute);
  };
}

// --- clicks ------------------------------------------------------------

export function installClicks(cfg: ResolvedConfig, sink: Sink): () => void {
  const handler = (e: MouseEvent) => {
    const target = e.target as Element | null;
    if (!target || target.nodeType !== 1) return;
    const priv = isPrivate(target, cfg.privacy);
    const ev: ClickEvent = {
      t: "click", ...base(cfg),
      sel: selectorFor(target),
      txt: priv ? undefined : safeText(target.textContent, cfg.privacy),
      x: e.clientX,
      y: e.clientY,
    };
    sink.push(ev);
  };
  // capture-phase so we record clicks even if app stops propagation
  document.addEventListener("click", handler, true);
  return () => document.removeEventListener("click", handler, true);
}

// --- web vitals --------------------------------------------------------

export function installVitals(cfg: ResolvedConfig, sink: Sink): () => void {
  const emit = (name: VitalEvent["name"], value: number) => {
    const ev: VitalEvent = {
      t: "vital", ...base(cfg),
      name, value, rating: rateVital(name, value),
    };
    sink.push(ev);
  };
  const observers: PerformanceObserver[] = [];
  const po = (type: string, cb: (list: PerformanceObserverEntryList) => void, buffered = true) => {
    try {
      const o = new PerformanceObserver(cb);
      o.observe({ type, buffered } as PerformanceObserverInit);
      observers.push(o);
    } catch { /* not supported */ }
  };

  // FCP + TTFB from navigation timing.
  try {
    const navs = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    if (navs[0]) {
      const ttfb = Math.max(0, navs[0].responseStart - navs[0].startTime);
      emit("TTFB", ttfb);
    }
    const paints = performance.getEntriesByType("paint") as PerformanceEntry[];
    for (const p of paints) if (p.name === "first-contentful-paint") emit("FCP", p.startTime);
    // fallback observe in case the metrics land after init
    po("paint", (list) => {
      for (const e of list.getEntries()) if (e.name === "first-contentful-paint") emit("FCP", e.startTime);
    });
  } catch { /* ignore */ }

  // LCP — last value wins, reported on hidden/pagehide.
  let lcp = 0;
  po("largest-contentful-paint", (list) => {
    const entries = list.getEntries();
    const last = entries[entries.length - 1] as PerformanceEntry | undefined;
    if (last) lcp = last.startTime;
  });

  // CLS — cumulative, session-window style; Google's reference impl windows
  // but a simple cumulative sum is adequate for a <5KB collector.
  let cls = 0;
  po("layout-shift", (list) => {
    for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
      if (!entry.hadRecentInput) cls += entry.value;
    }
  });

  // INP — track worst interaction duration.
  let inp = 0;
  po("event", (list) => {
    for (const entry of list.getEntries() as (PerformanceEntry & { duration: number; interactionId?: number })[]) {
      if (entry.interactionId && entry.duration > inp) inp = entry.duration;
    }
  });

  const finalize = () => {
    if (lcp) emit("LCP", lcp);
    emit("CLS", cls);
    if (inp) emit("INP", inp);
  };
  const onHide = () => {
    if (document.visibilityState === "hidden") finalize();
  };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", finalize);

  return () => {
    for (const o of observers) o.disconnect();
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("pagehide", finalize);
  };
}

// --- errors ------------------------------------------------------------

export function installErrors(cfg: ResolvedConfig, sink: Sink): () => void {
  const origErr = console.error;
  const onConsole = function (this: Console, ...args: unknown[]) {
    try {
      const msg = args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
      const stack = args.find((a) => a instanceof Error) as Error | undefined;
      const ev: UXIErrorEvent = {
        t: "error", ...base(cfg),
        msg, kind: "console",
        stack: stack?.stack,
      };
      sink.push(ev);
    } catch { /* never crash host */ }
    return origErr.apply(this, args as []);
  };
  console.error = onConsole as typeof console.error;

  const onWin = (e: Event) => {
    const ee = e as globalThis.ErrorEvent;
    const ev: UXIErrorEvent = {
      t: "error", ...base(cfg),
      msg: ee.message || "window.onerror", kind: "window",
      src: ee.filename, line: ee.lineno, col: ee.colno,
      stack: ee.error?.stack,
    };
    sink.push(ev);
  };
  const onRej = (e: Event) => {
    const r = (e as PromiseRejectionEvent).reason;
    const ev: UXIErrorEvent = {
      t: "error", ...base(cfg),
      msg: r instanceof Error ? r.message : String(r),
      kind: "unhandledrejection",
      stack: r instanceof Error ? r.stack : undefined,
    };
    sink.push(ev);
  };
  window.addEventListener("error", onWin);
  window.addEventListener("unhandledrejection", onRej);

  return () => {
    console.error = origErr;
    window.removeEventListener("error", onWin);
    window.removeEventListener("unhandledrejection", onRej);
  };
}

// --- network failures --------------------------------------------------

export function installNetwork(cfg: ResolvedConfig, sink: Sink): () => void {
  const endpointHost = safeUrl(cfg.endpoint)?.host;
  const isSelf = (u: string) => {
    if (!endpointHost) return false;
    const parsed = safeUrl(u, typeof location !== "undefined" ? location.href : undefined);
    return parsed?.host === endpointHost;
  };

  // fetch wrapper
  const origFetch = typeof fetch === "function" ? fetch.bind(globalThis) : null;
  if (origFetch) {
    const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const url = input instanceof Request ? input.url : String(input);
      if (isSelf(url)) return origFetch(input, init);
      const t0 = Date.now();
      try {
        const res = await origFetch(input, init);
        if (res.status >= 400) emitNet("fetch", method, url, res.status, Date.now() - t0);
        return res;
      } catch (e) {
        emitNet("fetch", method, url, 0, Date.now() - t0);
        throw e;
      }
    };
    (globalThis as { fetch: typeof fetch }).fetch = wrapped as typeof fetch;
  }

  // XHR wrapper
  const XHR = typeof XMLHttpRequest !== "undefined" ? XMLHttpRequest.prototype : null;
  const origOpen = XHR?.open;
  const origSend = XHR?.send;
  type XHRExt = XMLHttpRequest & { _uxi?: { m: string; u: string; t: number } };
  if (XHR && origOpen && origSend) {
    XHR.open = function (this: XHRExt, method: string, url: string | URL, ...rest: unknown[]) {
      this._uxi = { m: String(method).toUpperCase(), u: String(url), t: 0 };
      return origOpen.call(this, method, url, ...(rest as [boolean]));
    } as typeof XMLHttpRequest.prototype.open;
    XHR.send = function (this: XHRExt, body?: Document | XMLHttpRequestBodyInit | null) {
      if (this._uxi) this._uxi.t = Date.now();
      const onLoad = () => {
        const meta = this._uxi;
        if (!meta) return;
        if (isSelf(meta.u)) return;
        if (this.status >= 400 || this.status === 0) {
          emitNet("xhr", meta.m, meta.u, this.status, Date.now() - meta.t);
        }
      };
      this.addEventListener("loadend", onLoad);
      return origSend.call(this, body ?? null);
    } as typeof XMLHttpRequest.prototype.send;
  }

  function emitNet(kind: NetFailEvent["kind"], method: string, url: string, status: number, ms: number) {
    const ev: NetFailEvent = { t: "netfail", ...base(cfg), method, ru: url, status, ms, kind };
    sink.push(ev);
  }

  return () => {
    if (origFetch) (globalThis as { fetch: typeof fetch }).fetch = origFetch as typeof fetch;
    if (XHR && origOpen && origSend) {
      XHR.open = origOpen;
      XHR.send = origSend;
    }
  };
}

function safeUrl(u: string, base?: string): URL | null {
  try { return base ? new URL(u, base) : new URL(u); } catch { return null; }
}
