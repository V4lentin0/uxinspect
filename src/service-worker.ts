import type { Page } from 'playwright';

export interface ServiceWorkerResult {
  page: string;
  registered: boolean;
  scriptUrl?: string;
  scope?: string;
  state?: 'installing' | 'installed' | 'activating' | 'activated' | 'redundant';
  caches: { name: string; entryCount: number; totalBytes?: number }[];
  offlineWorks?: boolean;
  workboxDetected: boolean;
  push: { supported: boolean; subscribed?: boolean };
  issues: {
    type:
      | 'not-registered'
      | 'too-broad-scope'
      | 'no-cache'
      | 'cache-too-large'
      | 'offline-broken'
      | 'missing-skip-waiting'
      | 'using-http-scope';
    detail: string;
  }[];
  passed: boolean;
}

type IssueType = ServiceWorkerResult['issues'][number]['type'];

const MAX_CACHE_BYTES = 50 * 1024 * 1024;

export async function auditServiceWorker(page: Page): Promise<ServiceWorkerResult> {
  const pageUrl = page.url();
  const issues: ServiceWorkerResult['issues'] = [];
  const addIssue = (type: IssueType, detail: string) => issues.push({ type, detail });

  const registrationInfo = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) {
      return { supported: false } as const;
    }
    try {
      const reg = await (navigator as any).serviceWorker.getRegistration();
      if (!reg) return { supported: true, registered: false } as const;
      const worker = reg.active || reg.installing || reg.waiting;
      return {
        supported: true,
        registered: true,
        scriptUrl: worker?.scriptURL as string | undefined,
        scope: reg.scope as string | undefined,
        state: worker?.state as
          | 'installing'
          | 'installed'
          | 'activating'
          | 'activated'
          | 'redundant'
          | undefined,
        hasActive: !!reg.active,
        hasWaiting: !!reg.waiting,
      } as const;
    } catch (e) {
      return { supported: true, registered: false, error: String(e) } as const;
    }
  });

  const cacheInfo = await page.evaluate(async () => {
    if (!('caches' in (self as any))) {
      return { supported: false, caches: [] as { name: string; entryCount: number; totalBytes?: number; urls: string[] }[] };
    }
    try {
      const names: string[] = await (self as any).caches.keys();
      const results: { name: string; entryCount: number; totalBytes?: number; urls: string[] }[] = [];
      for (const name of names) {
        try {
          const cache = await (self as any).caches.open(name);
          const requests: Request[] = await cache.keys();
          const urls = requests.map((r) => r.url);
          let totalBytes: number | undefined = 0;
          try {
            for (const req of requests) {
              const res = await cache.match(req);
              if (!res) continue;
              const lenHeader = res.headers.get('content-length');
              if (lenHeader) {
                totalBytes += parseInt(lenHeader, 10) || 0;
              } else {
                try {
                  const buf = await res.clone().arrayBuffer();
                  totalBytes += buf.byteLength;
                } catch {
                  totalBytes = undefined;
                  break;
                }
              }
            }
          } catch {
            totalBytes = undefined;
          }
          results.push({ name, entryCount: requests.length, totalBytes, urls });
        } catch {
          results.push({ name, entryCount: 0, urls: [] });
        }
      }
      return { supported: true, caches: results };
    } catch {
      return { supported: true, caches: [] };
    }
  });

  const pushInfo = await page.evaluate(async () => {
    const supported = typeof (self as any).PushManager !== 'undefined';
    if (!supported) return { supported: false, subscribed: undefined as boolean | undefined };
    try {
      const reg = await (navigator as any).serviceWorker.getRegistration();
      if (!reg?.pushManager) return { supported: true, subscribed: undefined };
      const sub = await reg.pushManager.getSubscription();
      return { supported: true, subscribed: !!sub };
    } catch {
      return { supported: true, subscribed: undefined };
    }
  });

  const workboxDetected = (() => {
    const allUrls: string[] = [];
    if (registrationInfo.registered && registrationInfo.scriptUrl) allUrls.push(registrationInfo.scriptUrl);
    for (const c of cacheInfo.caches) {
      for (const u of c.urls) allUrls.push(u);
      if (/workbox/i.test(c.name)) return true;
    }
    return allUrls.some((u) => /workbox-/i.test(u) || /\/workbox\//i.test(u));
  })();

  const caches = cacheInfo.caches.map((c) => ({
    name: c.name,
    entryCount: c.entryCount,
    totalBytes: c.totalBytes,
  }));

  if (!registrationInfo.supported || !('registered' in registrationInfo) || !registrationInfo.registered) {
    addIssue('not-registered', 'no service worker registration found');
  } else {
    if (registrationInfo.scope) {
      try {
        const scopeUrl = new URL(registrationInfo.scope);
        if (scopeUrl.protocol === 'http:' && scopeUrl.hostname !== 'localhost' && scopeUrl.hostname !== '127.0.0.1') {
          addIssue('using-http-scope', `scope uses http: ${registrationInfo.scope}`);
        }
        const pagePath = new URL(pageUrl).pathname;
        if (scopeUrl.pathname === '/' && pagePath !== '/' && pagePath.split('/').filter(Boolean).length > 0) {
          addIssue('too-broad-scope', `scope is '/' but page served at ${pagePath}`);
        }
      } catch {
        // ignore scope parse errors
      }
    }

    if (caches.length === 0) {
      addIssue('no-cache', 'service worker registered but no Cache Storage entries');
    }

    for (const c of caches) {
      if (typeof c.totalBytes === 'number' && c.totalBytes > MAX_CACHE_BYTES) {
        addIssue(
          'cache-too-large',
          `cache "${c.name}" is ${(c.totalBytes / (1024 * 1024)).toFixed(1)}MB (>50MB)`,
        );
      }
    }

    if (registrationInfo.hasWaiting) {
      addIssue('missing-skip-waiting', 'waiting worker present — skipWaiting not called on update');
    }
  }

  let offlineWorks: boolean | undefined;
  if (registrationInfo.registered && registrationInfo.state === 'activated') {
    try {
      await page.context().setOffline(true);
      try {
        await page.reload({ timeout: 8000, waitUntil: 'domcontentloaded' });
        const bodyText = await page.evaluate(() => document.body?.innerText?.trim().length ?? 0);
        offlineWorks = bodyText > 0;
      } catch {
        offlineWorks = false;
      } finally {
        await page.context().setOffline(false);
      }
    } catch {
      offlineWorks = undefined;
    }

    if (offlineWorks === false) {
      addIssue('offline-broken', 'page failed to load while offline');
    }
  }

  const result: ServiceWorkerResult = {
    page: pageUrl,
    registered: !!registrationInfo.registered,
    scriptUrl: registrationInfo.registered ? registrationInfo.scriptUrl : undefined,
    scope: registrationInfo.registered ? registrationInfo.scope : undefined,
    state: registrationInfo.registered ? registrationInfo.state : undefined,
    caches,
    offlineWorks,
    workboxDetected,
    push: { supported: pushInfo.supported, subscribed: pushInfo.subscribed },
    issues,
    passed: issues.length === 0 && !!registrationInfo.registered,
  };

  return result;
}
