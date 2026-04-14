import type { Page } from 'playwright';

export interface LongTaskSample {
  startTime: number;
  duration: number;
  attribution: { containerType?: string; containerSrc?: string; containerId?: string; containerName?: string }[];
}

export interface LoAFSample {
  startTime: number;
  duration: number;
  renderStart?: number;
  styleAndLayoutStart?: number;
  blockingDuration: number;
  scripts: { name?: string; invoker?: string; invokerType?: string; duration: number; sourceURL?: string; sourceFunctionName?: string; sourceCharPosition?: number }[];
}

export interface LongTasksResult {
  page: string;
  longTasks: LongTaskSample[];
  longAnimationFrames: LoAFSample[];
  totalBlockingMs: number;
  inpMs?: number;
  inpTarget?: string;
  passed: boolean;
}

interface InpEntry {
  duration: number;
  target: string;
}

export async function captureLongTasks(page: Page, durationMs = 5000): Promise<LongTasksResult> {
  await page.evaluate(() => {
    const w = window as unknown as { __uxi_longtasks: LongTaskSample[]; __uxi_loaf: LoAFSample[]; __uxi_inp: InpEntry[] };
    w.__uxi_longtasks = [];
    w.__uxi_loaf = [];
    w.__uxi_inp = [];

    try {
      new PerformanceObserver((list) => {
        const store = w.__uxi_longtasks;
        list.getEntries().forEach((e) => {
          const entry = e as PerformanceEntry & { attribution?: { containerType?: string; containerSrc?: string; containerId?: string; containerName?: string }[] };
          store.push({
            startTime: entry.startTime,
            duration: entry.duration,
            attribution: entry.attribution?.map((a) => ({
              containerType: a.containerType,
              containerSrc: a.containerSrc,
              containerId: a.containerId,
              containerName: a.containerName,
            })) ?? [],
          });
        });
      }).observe({ type: 'longtask', buffered: true });
    } catch (_) { /* unsupported */ }

    try {
      new PerformanceObserver((list) => {
        const store = w.__uxi_loaf;
        list.getEntries().forEach((e) => {
          const entry = e as PerformanceEntry & {
            renderStart?: number;
            styleAndLayoutStart?: number;
            blockingDuration: number;
            scripts?: { name?: string; invoker?: string; invokerType?: string; duration: number; sourceURL?: string; sourceFunctionName?: string; sourceCharPosition?: number }[];
          };
          store.push({
            startTime: entry.startTime,
            duration: entry.duration,
            renderStart: entry.renderStart,
            styleAndLayoutStart: entry.styleAndLayoutStart,
            blockingDuration: entry.blockingDuration ?? 0,
            scripts: entry.scripts?.map((s) => ({
              name: s.name,
              invoker: s.invoker,
              invokerType: s.invokerType,
              duration: s.duration,
              sourceURL: s.sourceURL,
              sourceFunctionName: s.sourceFunctionName,
              sourceCharPosition: s.sourceCharPosition,
            })) ?? [],
          });
        });
      }).observe({ type: 'long-animation-frame', buffered: true });
    } catch (_) { /* unsupported */ }

    try {
      new PerformanceObserver((list) => {
        const store = w.__uxi_inp;
        list.getEntries().forEach((e) => {
          const entry = e as PerformanceEntry & { interactionId?: number; target?: Element | null };
          if (!entry.interactionId) return;
          let selector = '';
          if (entry.target) {
            const el = entry.target;
            selector = el.tagName.toLowerCase();
            if (el.id) selector += `#${el.id}`;
            const firstClass = el.classList?.[0];
            if (firstClass) selector += `.${firstClass}`;
          }
          store.push({ duration: entry.duration, target: selector });
        });
      }).observe({ type: 'event', durationThreshold: 40, buffered: true } as PerformanceObserverInit);
    } catch (_) { /* unsupported */ }
  });

  await page.waitForTimeout(durationMs);

  const longTasks: LongTaskSample[] = await page.evaluate(
    () => (window as unknown as { __uxi_longtasks: LongTaskSample[] }).__uxi_longtasks ?? []
  );

  const longAnimationFrames: LoAFSample[] = await page.evaluate(
    () => (window as unknown as { __uxi_loaf: LoAFSample[] }).__uxi_loaf ?? []
  );

  const inpEntries: InpEntry[] = await page.evaluate(
    () => (window as unknown as { __uxi_inp: InpEntry[] }).__uxi_inp ?? []
  );

  const totalBlockingMs = longTasks.reduce(
    (sum, t) => sum + (t.duration > 50 ? t.duration - 50 : 0),
    0
  );

  let inpMs: number | undefined;
  let inpTarget: string | undefined;
  if (inpEntries.length > 0) {
    const worst = inpEntries.reduce((max, e) => (e.duration > max.duration ? e : max), inpEntries[0]);
    inpMs = worst.duration;
    inpTarget = worst.target || undefined;
  }

  const passed = totalBlockingMs < 600 && (inpMs === undefined || inpMs < 200);

  return {
    page: page.url(),
    longTasks,
    longAnimationFrames,
    totalBlockingMs,
    inpMs,
    inpTarget,
    passed,
  };
}
