import type { Page, Worker as PlaywrightWorker, ConsoleMessage } from 'playwright';

export interface WebWorkerEntry {
  url: string;
  kind: 'worker' | 'shared-worker' | 'service-worker';
  scope?: string;
  active: boolean;
  sizeBytes?: number;
  messageCount: number;
  errorCount: number;
}

export interface WebWorkerIssue {
  kind:
    | 'worker-error'
    | 'long-running-worker'
    | 'worker-blocking-main'
    | 'worker-fetch-failed'
    | 'too-many-workers'
    | 'no-module-worker';
  worker: string;
  message: string;
}

export interface WebWorkerAuditResult {
  page: string;
  workers: WebWorkerEntry[];
  issues: WebWorkerIssue[];
  passed: boolean;
}

export interface WebWorkerAuditOptions {
  durationMs?: number;
  maxWorkers?: number;
}

interface TrackerShared {
  url: string;
  createdAt: number;
}

interface TrackerMessage {
  url: string;
  at: number;
}

interface TrackerServiceWorker {
  scriptURL: string;
  scope: string;
  state: string;
}

interface InjectedState {
  sharedWorkers: TrackerShared[];
  postMessages: TrackerMessage[];
  classicWorkers: string[];
  moduleWorkers: string[];
}

type InjectedWindow = Window & { __uxi_web_worker_audit?: InjectedState };

const LONG_TASK_RTT_MS = 200;
const MODULE_ADVISE_BYTES = 10 * 1024;
const BURST_THRESHOLD_PER_SEC = 20;
const DEFAULT_DURATION_MS = 3000;
const DEFAULT_MAX_WORKERS = 8;
const RTT_TIMEOUT_MS = 500;

interface WorkerTracking {
  worker: PlaywrightWorker;
  url: string;
  messageCount: number;
  errorCount: number;
  alive: boolean;
}

export async function auditWebWorkers(
  page: Page,
  opts: WebWorkerAuditOptions = {},
): Promise<WebWorkerAuditResult> {
  const durationMs = opts.durationMs ?? DEFAULT_DURATION_MS;
  const maxWorkers = opts.maxWorkers ?? DEFAULT_MAX_WORKERS;
  const pageUrl = page.url();
  const issues: WebWorkerIssue[] = [];

  await page.addInitScript(() => {
    const w = window as Window & { __uxi_web_worker_audit?: InjectedState };
    if (w.__uxi_web_worker_audit) return;
    const state: InjectedState = {
      sharedWorkers: [],
      postMessages: [],
      classicWorkers: [],
      moduleWorkers: [],
    };
    w.__uxi_web_worker_audit = state;

    try {
      const OriginalWorker = window.Worker;
      if (OriginalWorker) {
        const patched = function PatchedWorker(
          this: Worker,
          scriptURL: string | URL,
          options?: WorkerOptions,
        ): Worker {
          const href =
            typeof scriptURL === 'string'
              ? scriptURL
              : scriptURL && typeof scriptURL.toString === 'function'
                ? scriptURL.toString()
                : '';
          try {
            if (options && options.type === 'module') state.moduleWorkers.push(href);
            else state.classicWorkers.push(href);
          } catch {
            /* ignore tracking errors */
          }
          const instance = new OriginalWorker(scriptURL, options);
          try {
            const origPost = instance.postMessage.bind(instance);
            instance.postMessage = function trackedPostMessage(
              msg: unknown,
              transferOrOptions?: Transferable[] | StructuredSerializeOptions,
            ): void {
              try {
                state.postMessages.push({ url: href, at: Date.now() });
              } catch {
                /* ignore */
              }
              if (Array.isArray(transferOrOptions)) {
                return origPost(msg, transferOrOptions);
              }
              if (transferOrOptions) {
                return origPost(msg, transferOrOptions as StructuredSerializeOptions);
              }
              return origPost(msg);
            } as Worker['postMessage'];
          } catch {
            /* ignore */
          }
          return instance;
        } as unknown as typeof Worker;
        patched.prototype = OriginalWorker.prototype;
        (window as unknown as { Worker: typeof Worker }).Worker = patched;
      }
    } catch {
      /* ignore Worker patch failure */
    }

    try {
      const OriginalShared = (window as unknown as { SharedWorker?: typeof SharedWorker })
        .SharedWorker;
      if (OriginalShared) {
        const patchedShared = function PatchedSharedWorker(
          this: SharedWorker,
          scriptURL: string | URL,
          options?: string | WorkerOptions,
        ): SharedWorker {
          const href =
            typeof scriptURL === 'string'
              ? scriptURL
              : scriptURL && typeof scriptURL.toString === 'function'
                ? scriptURL.toString()
                : '';
          try {
            state.sharedWorkers.push({ url: href, createdAt: Date.now() });
          } catch {
            /* ignore */
          }
          return new OriginalShared(scriptURL, options);
        } as unknown as typeof SharedWorker;
        patchedShared.prototype = OriginalShared.prototype;
        (window as unknown as { SharedWorker: typeof SharedWorker }).SharedWorker = patchedShared;
      }
    } catch {
      /* ignore SharedWorker patch failure */
    }
  });

  const tracking = new Map<PlaywrightWorker, WorkerTracking>();

  const attachListeners = (worker: PlaywrightWorker): void => {
    if (tracking.has(worker)) return;
    const entry: WorkerTracking = {
      worker,
      url: worker.url(),
      messageCount: 0,
      errorCount: 0,
      alive: true,
    };
    tracking.set(worker, entry);

    const onConsole = (msg: ConsoleMessage): void => {
      entry.messageCount++;
      if (msg.type() === 'error') entry.errorCount++;
    };
    const onClose = (): void => {
      entry.alive = false;
    };
    try {
      worker.on('console', onConsole);
      worker.on('close', onClose);
    } catch {
      /* older Playwright may not surface these */
    }
  };

  for (const existing of page.workers()) attachListeners(existing);
  const onNewWorker = (worker: PlaywrightWorker): void => attachListeners(worker);
  page.on('worker', onNewWorker);

  const pageErrors: { message: string; stack?: string }[] = [];
  const onPageError = (err: Error): void => {
    pageErrors.push({ message: err.message, stack: err.stack });
  };
  page.on('pageerror', onPageError);

  await page.waitForTimeout(durationMs);

  page.off('worker', onNewWorker);
  page.off('pageerror', onPageError);

  const injected = await page
    .evaluate<InjectedState | null>(() => {
      const w = window as InjectedWindow;
      return w.__uxi_web_worker_audit
        ? {
            sharedWorkers: w.__uxi_web_worker_audit.sharedWorkers.slice(),
            postMessages: w.__uxi_web_worker_audit.postMessages.slice(),
            classicWorkers: w.__uxi_web_worker_audit.classicWorkers.slice(),
            moduleWorkers: w.__uxi_web_worker_audit.moduleWorkers.slice(),
          }
        : null;
    })
    .catch(() => null);

  const serviceWorkers = await page
    .evaluate<TrackerServiceWorker[]>(async () => {
      const out: TrackerServiceWorker[] = [];
      const nav = navigator as Navigator & {
        serviceWorker?: {
          getRegistrations?: () => Promise<ReadonlyArray<ServiceWorkerRegistration>>;
        };
      };
      if (!nav.serviceWorker || !nav.serviceWorker.getRegistrations) return out;
      try {
        const regs = await nav.serviceWorker.getRegistrations();
        for (const reg of regs) {
          const sw = reg.active || reg.installing || reg.waiting;
          if (!sw) continue;
          out.push({
            scriptURL: sw.scriptURL,
            scope: reg.scope,
            state: sw.state,
          });
        }
      } catch {
        /* ignore */
      }
      return out;
    })
    .catch(() => [] as TrackerServiceWorker[]);

  const entries: WebWorkerEntry[] = [];
  const classicUrls = new Set<string>(injected?.classicWorkers ?? []);
  const moduleUrls = new Set<string>(injected?.moduleWorkers ?? []);
  const postMessageByUrl = new Map<string, number>();
  if (injected) {
    for (const pm of injected.postMessages) {
      postMessageByUrl.set(pm.url, (postMessageByUrl.get(pm.url) ?? 0) + 1);
    }
  }

  for (const [, tracked] of tracking) {
    const url = tracked.url;
    const postCount = postMessageByUrl.get(url) ?? 0;
    let sizeBytes: number | undefined;
    if (/^https?:/i.test(url)) {
      try {
        const res = await page.request.get(url, { failOnStatusCode: false });
        if (res.status() >= 400) {
          issues.push({
            kind: 'worker-fetch-failed',
            worker: url,
            message: `worker script fetch returned ${res.status()}`,
          });
        } else {
          try {
            const body = await res.body();
            sizeBytes = body.byteLength;
          } catch {
            sizeBytes = undefined;
          }
        }
      } catch {
        /* network failure — skip */
      }
    }

    entries.push({
      url,
      kind: 'worker',
      active: tracked.alive,
      sizeBytes,
      messageCount: tracked.messageCount + postCount,
      errorCount: tracked.errorCount,
    });

    if (tracked.errorCount > 0) {
      issues.push({
        kind: 'worker-error',
        worker: url,
        message: `worker logged ${tracked.errorCount} console error(s)`,
      });
    }

    if (
      classicUrls.has(url) &&
      !moduleUrls.has(url) &&
      typeof sizeBytes === 'number' &&
      sizeBytes > MODULE_ADVISE_BYTES
    ) {
      issues.push({
        kind: 'no-module-worker',
        worker: url,
        message: `classic worker ${sizeBytes} bytes — consider { type: 'module' }`,
      });
    }

    if (durationMs > 0 && postCount / (durationMs / 1000) > BURST_THRESHOLD_PER_SEC) {
      issues.push({
        kind: 'worker-blocking-main',
        worker: url,
        message: `postMessage burst ${Math.round(postCount / (durationMs / 1000))}/s exceeds ${BURST_THRESHOLD_PER_SEC}/s`,
      });
    }

    if (tracked.alive) {
      const drift = await measureRoundTripDrift(tracked.worker);
      if (drift !== null && drift > LONG_TASK_RTT_MS) {
        issues.push({
          kind: 'long-running-worker',
          worker: url,
          message: `worker roundtrip ${Math.round(drift)}ms > ${LONG_TASK_RTT_MS}ms threshold`,
        });
      }
    }
  }

  if (injected) {
    for (const sw of injected.sharedWorkers) {
      entries.push({
        url: sw.url,
        kind: 'shared-worker',
        active: true,
        messageCount: 0,
        errorCount: 0,
      });
    }
  }

  for (const sw of serviceWorkers) {
    entries.push({
      url: sw.scriptURL,
      kind: 'service-worker',
      scope: sw.scope,
      active: sw.state === 'activated' || sw.state === 'activating',
      messageCount: 0,
      errorCount: 0,
    });
  }

  for (const err of pageErrors) {
    const match = entries.find(
      (e) =>
        e.kind === 'worker' && typeof err.stack === 'string' && err.stack.includes(e.url),
    );
    if (match) {
      match.errorCount++;
      issues.push({
        kind: 'worker-error',
        worker: match.url,
        message: err.message,
      });
    }
  }

  if (entries.length > maxWorkers) {
    issues.push({
      kind: 'too-many-workers',
      worker: pageUrl,
      message: `${entries.length} workers exceeds max of ${maxWorkers}`,
    });
  }

  return {
    page: pageUrl,
    workers: entries,
    issues,
    passed: issues.length === 0,
  };
}

async function measureRoundTripDrift(worker: PlaywrightWorker): Promise<number | null> {
  try {
    const result = await Promise.race<number | null>([
      worker.evaluate<number>(() => {
        const start = performance.now();
        return performance.now() - start;
      }),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), RTT_TIMEOUT_MS);
      }),
    ]);
    if (result === null) return RTT_TIMEOUT_MS + 1;
    const wallStart = Date.now();
    await worker.evaluate(() => 1);
    const wallEnd = Date.now();
    return wallEnd - wallStart;
  } catch {
    return null;
  }
}
