import type { Page } from 'playwright';

export interface FrustrationSignalOptions {
  rageClickWindowMs?: number;
  rageClickThreshold?: number;
  deadClickWaitMs?: number;
  uTurnWindowMs?: number;
  errorClickWindowMs?: number;
  thrashedCursorWindowMs?: number;
  thrashedCursorThreshold?: number;
}

export interface FrustrationEvidence {
  selector: string;
  ts: number;
  evidence: Record<string, unknown>;
}

export interface FrustrationSignalResult {
  rageClicks: FrustrationEvidence[];
  deadClicks: FrustrationEvidence[];
  uTurns: FrustrationEvidence[];
  errorClicks: FrustrationEvidence[];
  thrashedCursors: FrustrationEvidence[];
  clicksObserved: number;
  navigationsObserved: number;
  passed: boolean;
}

export interface FrustrationHandle {
  result(): Promise<FrustrationSignalResult>;
  detach(): void;
}

interface RawClick {
  selector: string;
  ts: number;
  x: number;
  y: number;
  mutationOccurred: boolean;
  navigationOccurred: boolean;
  networkOccurred: boolean;
}

interface RawNavigation {
  url: string;
  ts: number;
  via: 'pushState' | 'replaceState' | 'popstate' | 'load' | 'back';
}

interface RawError {
  ts: number;
  message: string;
}

interface RawMouseMove {
  ts: number;
  x: number;
  y: number;
}

interface FrustrationCollector {
  clicks: RawClick[];
  navigations: RawNavigation[];
  errors: RawError[];
  mouseMoves: RawMouseMove[];
}

const GLOBAL_KEY = '__uxi_frustration_signals';

/**
 * Attaches synthetic-user frustration signal detection to a Playwright page.
 *
 * Signals mirror what Hotjar/LogRocket/FullStory capture from real users:
 *  - rage-click  : 3+ clicks on same target within 500ms
 *  - dead-click  : click with no DOM mutation, navigation, or network within 1s
 *  - u-turn      : navigation followed by history.back() within 5s
 *  - error-click : click followed by a console error within 500ms
 *  - thrashed-cursor : >10 rapid mouse direction changes within 500ms
 */
export async function attachFrustrationSignals(
  page: Page,
  opts: FrustrationSignalOptions = {},
): Promise<FrustrationHandle> {
  const rageClickWindowMs = opts.rageClickWindowMs ?? 500;
  const rageClickThreshold = opts.rageClickThreshold ?? 3;
  const deadClickWaitMs = opts.deadClickWaitMs ?? 1000;
  const uTurnWindowMs = opts.uTurnWindowMs ?? 5000;
  const errorClickWindowMs = opts.errorClickWindowMs ?? 500;
  const thrashedCursorWindowMs = opts.thrashedCursorWindowMs ?? 500;
  const thrashedCursorThreshold = opts.thrashedCursorThreshold ?? 10;

  const pageErrors: { ts: number; message: string }[] = [];
  const consoleErrors: { ts: number; message: string }[] = [];
  const requestCounters = new Map<string, number>();
  let requestSeq = 0;
  const netKey = () => `req-${++requestSeq}`;

  const onPageError = (err: Error): void => {
    pageErrors.push({ ts: Date.now(), message: err.message });
  };
  const onConsole = (msg: { type(): string; text(): string }): void => {
    if (msg.type() === 'error') {
      consoleErrors.push({ ts: Date.now(), message: msg.text() });
    }
  };
  const onRequest = (): void => {
    requestCounters.set(netKey(), Date.now());
  };

  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  page.on('request', onRequest);

  // Inject the in-page collector as early as possible so we catch navigations too.
  await page.addInitScript(
    ({ key, deadWait }: { key: string; deadWait: number }) => {
      interface RawClick {
        selector: string;
        ts: number;
        x: number;
        y: number;
        mutationOccurred: boolean;
        navigationOccurred: boolean;
        networkOccurred: boolean;
      }
      interface RawNavigation {
        url: string;
        ts: number;
        via: 'pushState' | 'replaceState' | 'popstate' | 'load' | 'back';
      }
      interface RawError {
        ts: number;
        message: string;
      }
      interface RawMouseMove {
        ts: number;
        x: number;
        y: number;
      }
      interface Collector {
        clicks: RawClick[];
        navigations: RawNavigation[];
        errors: RawError[];
        mouseMoves: RawMouseMove[];
      }

      const w = window as unknown as Record<string, unknown>;
      if (w[key]) return;

      // Persist across same-origin navigations via sessionStorage.
      const storageKey = key;
      let previous: Collector | null = null;
      try {
        const raw = sessionStorage.getItem(storageKey);
        if (raw) previous = JSON.parse(raw) as Collector;
      } catch {
        previous = null;
      }
      const state: Collector = previous ?? {
        clicks: [],
        navigations: [],
        errors: [],
        mouseMoves: [],
      };
      w[key] = state;

      const flush = (): void => {
        try {
          sessionStorage.setItem(storageKey, JSON.stringify(state));
        } catch {
          // quota / disabled — ignore
        }
      };
      window.addEventListener('pagehide', flush);
      window.addEventListener('beforeunload', flush);
      // Flush on a modest interval so we don't lose state on hard crashes.
      setInterval(flush, 500);

      const buildSelector = (el: Element | null): string => {
        if (!el) return '(unknown)';
        if (el.id) return '#' + CSS.escape(el.id);
        const testId = el.getAttribute('data-testid');
        if (testId) return '[data-testid="' + testId + '"]';
        const tag = el.tagName ? el.tagName.toLowerCase() : 'node';
        const cls = (el.getAttribute('class') || '')
          .trim()
          .split(/\s+/)
          .filter((c) => c.length > 0)
          .slice(0, 2)
          .join('.');
        let sel = tag + (cls ? '.' + cls : '');
        const parent = el.parentElement;
        if (parent) {
          const sibs = Array.from(parent.children).filter(
            (c) => c.tagName === el.tagName,
          );
          if (sibs.length > 1) {
            const idx = sibs.indexOf(el);
            if (idx >= 0) sel += ':nth-of-type(' + (idx + 1) + ')';
          }
        }
        return sel;
      };

      // Track clicks + side effects.
      document.addEventListener(
        'click',
        (ev) => {
          const target = (ev.target as Element | null) ?? null;
          const selector = buildSelector(target);
          const click: RawClick = {
            selector,
            ts: Date.now(),
            x: (ev as MouseEvent).clientX ?? 0,
            y: (ev as MouseEvent).clientY ?? 0,
            mutationOccurred: false,
            navigationOccurred: false,
            networkOccurred: false,
          };
          state.clicks.push(click);

          const startUrl = location.href;
          const mo = new MutationObserver(() => {
            click.mutationOccurred = true;
          });
          try {
            mo.observe(document.documentElement, {
              childList: true,
              subtree: true,
              attributes: true,
              characterData: true,
            });
          } catch {
            // ignore observer failure
          }
          const netCountBefore = state.navigations.length;
          window.setTimeout(() => {
            mo.disconnect();
            if (location.href !== startUrl) click.navigationOccurred = true;
            if (state.navigations.length > netCountBefore) click.navigationOccurred = true;
          }, deadWait);
        },
        true,
      );

      // Flag network activity per open click (coarse: fetch + XHR).
      try {
        const originalFetch = window.fetch?.bind(window);
        if (originalFetch) {
          window.fetch = ((...args: Parameters<typeof fetch>) => {
            if (state.clicks.length) {
              const last = state.clicks[state.clicks.length - 1];
              if (last && Date.now() - last.ts <= deadWait) {
                last.networkOccurred = true;
              }
            }
            return originalFetch(...args);
          }) as typeof fetch;
        }
      } catch {
        // ignore fetch patch failure
      }
      try {
        const XHR = XMLHttpRequest.prototype;
        const originalSend = XHR.send;
        XHR.send = function (this: XMLHttpRequest, ...args: unknown[]) {
          if (state.clicks.length) {
            const last = state.clicks[state.clicks.length - 1];
            if (last && Date.now() - last.ts <= deadWait) {
              last.networkOccurred = true;
            }
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return originalSend.apply(this, args as any);
        };
      } catch {
        // ignore XHR patch failure
      }

      // Navigation tracking: pushState / replaceState / popstate / load.
      const pushNav = (via: RawNavigation['via']) => {
        state.navigations.push({ url: location.href, ts: Date.now(), via });
      };
      try {
        const origPush = history.pushState;
        history.pushState = function (
          this: History,
          ...args: Parameters<typeof history.pushState>
        ) {
          const r = origPush.apply(this, args);
          pushNav('pushState');
          return r;
        };
        const origReplace = history.replaceState;
        history.replaceState = function (
          this: History,
          ...args: Parameters<typeof history.replaceState>
        ) {
          const r = origReplace.apply(this, args);
          pushNav('replaceState');
          return r;
        };
      } catch {
        // ignore history patch failure
      }
      window.addEventListener('popstate', () => pushNav('popstate'));
      window.addEventListener('load', () => pushNav('load'));

      // history.back override to flag u-turn more cleanly.
      try {
        const origBack = history.back.bind(history);
        history.back = () => {
          pushNav('back');
          return origBack();
        };
      } catch {
        // ignore history.back patch failure
      }

      // Page-side error capture (redundant with Playwright listeners but cheap).
      window.addEventListener('error', (ev) => {
        state.errors.push({
          ts: Date.now(),
          message: String(
            (ev as ErrorEvent).message || (ev as ErrorEvent).error || 'error',
          ),
        });
      });
      window.addEventListener('unhandledrejection', (ev) => {
        state.errors.push({
          ts: Date.now(),
          message: String(
            (ev as PromiseRejectionEvent).reason || 'unhandledrejection',
          ),
        });
      });

      // Mouse movement sampling for thrashed-cursor detection.
      let lastMoveTs = 0;
      document.addEventListener(
        'mousemove',
        (ev) => {
          const now = Date.now();
          if (now - lastMoveTs < 16) return; // ~60fps cap
          lastMoveTs = now;
          state.mouseMoves.push({
            ts: now,
            x: (ev as MouseEvent).clientX ?? 0,
            y: (ev as MouseEvent).clientY ?? 0,
          });
          if (state.mouseMoves.length > 2000) state.mouseMoves.shift();
        },
        { capture: true, passive: true },
      );
    },
    { key: GLOBAL_KEY, deadWait: deadClickWaitMs },
  );

  let detached = false;

  return {
    async result(): Promise<FrustrationSignalResult> {
      const raw = await page
        .evaluate((key: string) => {
          const w = window as unknown as Record<string, unknown>;
          const state = w[key] as FrustrationCollector | undefined;
          if (!state) {
            return {
              clicks: [],
              navigations: [],
              errors: [],
              mouseMoves: [],
            } satisfies FrustrationCollector;
          }
          return state;
        }, GLOBAL_KEY)
        .catch(
          (): FrustrationCollector => ({
            clicks: [],
            navigations: [],
            errors: [],
            mouseMoves: [],
          }),
        );

      // Merge in page-level errors from Playwright listeners.
      const allErrors: { ts: number; message: string }[] = [
        ...raw.errors,
        ...pageErrors,
        ...consoleErrors,
      ].sort((a, b) => a.ts - b.ts);

      // Rage-click: per-selector bucket, 3+ within window.
      const rageClicks: FrustrationEvidence[] = [];
      const seenRageStart = new Map<string, number>();
      const bySelector = new Map<string, RawClick[]>();
      for (const c of raw.clicks) {
        const arr = bySelector.get(c.selector) ?? [];
        arr.push(c);
        bySelector.set(c.selector, arr);
      }
      for (const [selector, clicks] of bySelector) {
        clicks.sort((a, b) => a.ts - b.ts);
        for (let i = 0; i + rageClickThreshold - 1 < clicks.length; i++) {
          const window = clicks.slice(i, i + rageClickThreshold);
          const first = window[0];
          const last = window[window.length - 1];
          if (!first || !last) continue;
          if (last.ts - first.ts <= rageClickWindowMs) {
            if (seenRageStart.get(selector) === first.ts) continue;
            seenRageStart.set(selector, first.ts);
            rageClicks.push({
              selector,
              ts: first.ts,
              evidence: {
                clicksInWindow: window.length,
                windowMs: last.ts - first.ts,
                positions: window.map((w) => ({ x: w.x, y: w.y })),
              },
            });
          }
        }
      }

      // Dead-click: no mutation + no nav + no network within the dead-click wait window.
      const deadClicks: FrustrationEvidence[] = [];
      for (const c of raw.clicks) {
        if (!c.mutationOccurred && !c.navigationOccurred && !c.networkOccurred) {
          deadClicks.push({
            selector: c.selector,
            ts: c.ts,
            evidence: { waitMs: deadClickWaitMs, x: c.x, y: c.y },
          });
        }
      }

      // U-turn: forward navigation followed by a back navigation within window.
      const uTurns: FrustrationEvidence[] = [];
      const navs = raw.navigations
        .slice()
        .sort((a, b) => a.ts - b.ts);
      for (let i = 0; i < navs.length; i++) {
        const n = navs[i];
        if (!n) continue;
        if (n.via !== 'pushState' && n.via !== 'load' && n.via !== 'replaceState') continue;
        for (let j = i + 1; j < navs.length; j++) {
          const back = navs[j];
          if (!back) continue;
          if (back.ts - n.ts > uTurnWindowMs) break;
          if (back.via === 'back' || back.via === 'popstate') {
            uTurns.push({
              selector: n.url,
              ts: n.ts,
              evidence: {
                returnedAfterMs: back.ts - n.ts,
                fromUrl: n.url,
                backVia: back.via,
              },
            });
            break;
          }
        }
      }

      // Error-click: a click followed by an error within the window.
      const errorClicks: FrustrationEvidence[] = [];
      for (const c of raw.clicks) {
        const err = allErrors.find(
          (e) => e.ts >= c.ts && e.ts - c.ts <= errorClickWindowMs,
        );
        if (err) {
          errorClicks.push({
            selector: c.selector,
            ts: c.ts,
            evidence: {
              errorMessage: err.message,
              latencyMs: err.ts - c.ts,
            },
          });
        }
      }

      // Thrashed-cursor: many direction reversals inside a sliding window.
      const thrashedCursors: FrustrationEvidence[] = [];
      const moves = raw.mouseMoves;
      if (moves.length >= thrashedCursorThreshold + 2) {
        const directions: number[] = [];
        for (let i = 1; i < moves.length; i++) {
          const a = moves[i - 1];
          const b = moves[i];
          if (!a || !b) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          if (dx === 0 && dy === 0) {
            directions.push(0);
            continue;
          }
          const ang = Math.atan2(dy, dx);
          directions.push(ang);
        }

        let reversals = 0;
        let windowStartIdx = 0;
        const reported = new Set<number>();
        for (let i = 2; i < directions.length; i++) {
          const prev = directions[i - 1];
          const cur = directions[i];
          if (prev === undefined || cur === undefined) continue;
          const diff = Math.abs(normalizeAngle(cur - prev));
          if (diff > (Math.PI * 2) / 3) {
            reversals++;
          }
          // Drop reversals that fall outside the thrashedCursorWindowMs window.
          while (
            windowStartIdx < i &&
            (moves[i]?.ts ?? 0) - (moves[windowStartIdx]?.ts ?? 0) > thrashedCursorWindowMs
          ) {
            const ws = directions[windowStartIdx];
            const wsNext = directions[windowStartIdx + 1];
            if (
              ws !== undefined &&
              wsNext !== undefined &&
              Math.abs(normalizeAngle(wsNext - ws)) > (Math.PI * 2) / 3
            ) {
              reversals = Math.max(0, reversals - 1);
            }
            windowStartIdx++;
          }

          if (reversals >= thrashedCursorThreshold) {
            const startMove = moves[windowStartIdx];
            const endMove = moves[i];
            if (startMove && endMove && !reported.has(startMove.ts)) {
              reported.add(startMove.ts);
              thrashedCursors.push({
                selector: '(cursor)',
                ts: startMove.ts,
                evidence: {
                  reversals,
                  windowMs: endMove.ts - startMove.ts,
                  samples: i - windowStartIdx + 1,
                },
              });
            }
          }
        }
      }

      return {
        rageClicks,
        deadClicks,
        uTurns,
        errorClicks,
        thrashedCursors,
        clicksObserved: raw.clicks.length,
        navigationsObserved: raw.navigations.length,
        passed:
          rageClicks.length === 0 &&
          deadClicks.length === 0 &&
          uTurns.length === 0 &&
          errorClicks.length === 0 &&
          thrashedCursors.length === 0,
      };
    },
    detach(): void {
      if (detached) return;
      detached = true;
      page.off('pageerror', onPageError);
      page.off('console', onConsole);
      page.off('request', onRequest);
    },
  };
}

function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
