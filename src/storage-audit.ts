import type { Page } from 'playwright';

export interface StorageEntry {
  storage: 'localStorage' | 'sessionStorage' | 'indexedDB' | 'cacheStorage';
  key: string;
  sizeBytes: number;
  sample?: string;
}

export interface StorageAuditResult {
  page: string;
  entries: StorageEntry[];
  totals: {
    localStorageBytes: number;
    sessionStorageBytes: number;
    indexedDbBytes: number;
    cacheStorageBytes: number;
    quotaBytes?: number;
    usageBytes?: number;
    percentUsed?: number;
  };
  issues: {
    kind:
      | 'over-quota-warning'
      | 'large-key'
      | 'pii-pattern'
      | 'jwt-in-localstorage'
      | 'secret-in-storage';
    key: string;
    detail: string;
  }[];
  passed: boolean;
}

type IssueKind = StorageAuditResult['issues'][number]['kind'];

interface RawKeyValueEntry {
  storage: 'localStorage' | 'sessionStorage';
  key: string;
  value: string;
  sizeBytes: number;
}

interface RawIdbEntry {
  storage: 'indexedDB';
  key: string;
  sizeBytes: number;
}

interface RawCacheEntry {
  storage: 'cacheStorage';
  key: string;
  sizeBytes: number;
}

interface RawCollectResult {
  keyValue: RawKeyValueEntry[];
  idb: RawIdbEntry[];
  cache: RawCacheEntry[];
  quota: {
    quotaBytes?: number;
    usageBytes?: number;
  };
}

interface CollectOptions {
  maxDatabases: number;
  maxObjectsPerStore: number;
}

const LARGE_KEY_BYTES = 1024 * 1024;
const QUOTA_WARN_PCT = 80;
const MAX_IDB_DATABASES = 10;
const MAX_IDB_OBJECTS_PER_STORE = 100;
const SAMPLE_CHARS = 120;

const PII_RE = /"?(email|ssn|credit_?card|cvv)"?\s*:\s*"[^"]+"/i;
const JWT_KEY_RE = /token|jwt|auth|session|access/i;
const JWT_VALUE_RE = /^eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/;
const SECRET_RE = /sk_live_|AKIA|AIza/;

function makeSample(value: string): string {
  return value.length > SAMPLE_CHARS ? value.slice(0, SAMPLE_CHARS) : value;
}

function addIssue(
  bucket: StorageAuditResult['issues'],
  kind: IssueKind,
  key: string,
  detail: string
): void {
  bucket.push({ kind, key, detail });
}

function evaluateKeyValue(
  entry: RawKeyValueEntry,
  issues: StorageAuditResult['issues']
): void {
  if (
    entry.storage === 'localStorage' &&
    entry.sizeBytes > LARGE_KEY_BYTES
  ) {
    const mb = (entry.sizeBytes / (1024 * 1024)).toFixed(2);
    addIssue(
      issues,
      'large-key',
      entry.key,
      `localStorage key "${entry.key}" is ${mb} MB`
    );
  }
  if (PII_RE.test(entry.value)) {
    addIssue(
      issues,
      'pii-pattern',
      entry.key,
      `${entry.storage} key "${entry.key}" contains PII-like field (email/ssn/credit_card/cvv)`
    );
  }
  if (
    entry.storage === 'localStorage' &&
    JWT_KEY_RE.test(entry.key) &&
    JWT_VALUE_RE.test(entry.value.trim())
  ) {
    addIssue(
      issues,
      'jwt-in-localstorage',
      entry.key,
      `JWT-shaped token in localStorage key "${entry.key}"; prefer HttpOnly cookie`
    );
  }
  if (SECRET_RE.test(entry.value)) {
    addIssue(
      issues,
      'secret-in-storage',
      entry.key,
      `${entry.storage} key "${entry.key}" contains a provider-prefixed secret`
    );
  }
}

function sumKeyValue(
  entries: RawKeyValueEntry[],
  target: 'localStorage' | 'sessionStorage'
): number {
  let total = 0;
  for (const e of entries) {
    if (e.storage === target) total += e.sizeBytes;
  }
  return total;
}

function sumSized(entries: { sizeBytes: number }[]): number {
  let total = 0;
  for (const e of entries) total += e.sizeBytes;
  return total;
}

async function collectInPage(options: CollectOptions): Promise<RawCollectResult> {
  const keyValue: RawKeyValueEntry[] = [];
  const idb: RawIdbEntry[] = [];
  const cache: RawCacheEntry[] = [];
  const quota: { quotaBytes?: number; usageBytes?: number } = {};

  const collectKv = (
    storage: Storage,
    label: 'localStorage' | 'sessionStorage'
  ): void => {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key === null) continue;
      const value = storage.getItem(key) ?? '';
      const sizeBytes = (key.length + value.length) * 2;
      keyValue.push({ storage: label, key, value, sizeBytes });
    }
  };

  try {
    collectKv(window.localStorage, 'localStorage');
  } catch {
    // storage may throw SecurityError in sandboxed contexts
  }
  try {
    collectKv(window.sessionStorage, 'sessionStorage');
  } catch {
    // ignore
  }

  type IdbFactoryWithDatabases = IDBFactory & {
    databases?: () => Promise<{ name?: string; version?: number }[]>;
  };
  const factory = window.indexedDB as IdbFactoryWithDatabases;
  if (factory && typeof factory.databases === 'function') {
    try {
      const dbs = await factory.databases();
      const limited = dbs.slice(0, options.maxDatabases);
      for (const info of limited) {
        if (!info.name) continue;
        const dbName = info.name;
        try {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = factory.open(dbName);
            req.onsuccess = (): void => resolve(req.result);
            req.onerror = (): void => reject(req.error);
            req.onblocked = (): void => reject(new Error('blocked'));
          });
          const storeNames = Array.from(db.objectStoreNames);
          for (const storeName of storeNames) {
            let tx: IDBTransaction;
            try {
              tx = db.transaction(storeName, 'readonly');
            } catch {
              continue;
            }
            const store = tx.objectStore(storeName);
            const count = await new Promise<number>((resolve) => {
              const req = store.count();
              req.onsuccess = (): void => resolve(req.result);
              req.onerror = (): void => resolve(0);
            });
            let sampled = 0;
            let approxBytes = 0;
            await new Promise<void>((resolve) => {
              const req = store.openCursor();
              req.onsuccess = (): void => {
                const cursor = req.result;
                if (!cursor || sampled >= options.maxObjectsPerStore) {
                  resolve();
                  return;
                }
                try {
                  const serialized = JSON.stringify(cursor.value);
                  approxBytes += (serialized?.length ?? 0) * 2;
                } catch {
                  // skip unserializable entries
                }
                sampled += 1;
                cursor.continue();
              };
              req.onerror = (): void => resolve();
            });
            const scale =
              sampled > 0 && count > sampled ? count / sampled : 1;
            const estimated = Math.round(approxBytes * scale);
            idb.push({
              storage: 'indexedDB',
              key: `${dbName}/${storeName}`,
              sizeBytes: estimated,
            });
          }
          db.close();
        } catch {
          // ignore DB-level failures and continue
        }
      }
    } catch {
      // indexedDB.databases rejected, skip
    }
  }

  if (typeof caches !== 'undefined') {
    try {
      const cacheNames = await caches.keys();
      for (const cacheName of cacheNames) {
        try {
          const store = await caches.open(cacheName);
          const reqs = await store.keys();
          let total = 0;
          let entryCount = 0;
          for (const req of reqs) {
            entryCount += 1;
            try {
              const resp = await store.match(req);
              if (!resp) continue;
              const cloned = resp.clone();
              const blob = await cloned.blob();
              total += blob.size;
            } catch {
              // ignore entry-level failures
            }
          }
          cache.push({
            storage: 'cacheStorage',
            key: `${cacheName} (${entryCount} entries)`,
            sizeBytes: total,
          });
        } catch {
          // ignore cache-level failures
        }
      }
    } catch {
      // caches.keys rejected, skip
    }
  }

  if (navigator.storage && typeof navigator.storage.estimate === 'function') {
    try {
      const est = await navigator.storage.estimate();
      if (typeof est.quota === 'number') quota.quotaBytes = est.quota;
      if (typeof est.usage === 'number') quota.usageBytes = est.usage;
    } catch {
      // ignore
    }
  }

  return { keyValue, idb, cache, quota };
}

export async function auditStorage(page: Page): Promise<StorageAuditResult> {
  const pageUrl = page.url();
  const raw = await page.evaluate(collectInPage, {
    maxDatabases: MAX_IDB_DATABASES,
    maxObjectsPerStore: MAX_IDB_OBJECTS_PER_STORE,
  });

  const entries: StorageEntry[] = [];
  const issues: StorageAuditResult['issues'] = [];

  for (const kv of raw.keyValue) {
    entries.push({
      storage: kv.storage,
      key: kv.key,
      sizeBytes: kv.sizeBytes,
      sample: makeSample(kv.value),
    });
    evaluateKeyValue(kv, issues);
  }
  for (const ix of raw.idb) {
    entries.push({
      storage: ix.storage,
      key: ix.key,
      sizeBytes: ix.sizeBytes,
    });
  }
  for (const ch of raw.cache) {
    entries.push({
      storage: ch.storage,
      key: ch.key,
      sizeBytes: ch.sizeBytes,
    });
  }

  const localStorageBytes = sumKeyValue(raw.keyValue, 'localStorage');
  const sessionStorageBytes = sumKeyValue(raw.keyValue, 'sessionStorage');
  const indexedDbBytes = sumSized(raw.idb);
  const cacheStorageBytes = sumSized(raw.cache);

  const totals: StorageAuditResult['totals'] = {
    localStorageBytes,
    sessionStorageBytes,
    indexedDbBytes,
    cacheStorageBytes,
  };
  if (typeof raw.quota.quotaBytes === 'number') {
    totals.quotaBytes = raw.quota.quotaBytes;
  }
  if (typeof raw.quota.usageBytes === 'number') {
    totals.usageBytes = raw.quota.usageBytes;
  }
  if (
    typeof totals.quotaBytes === 'number' &&
    typeof totals.usageBytes === 'number' &&
    totals.quotaBytes > 0
  ) {
    totals.percentUsed = (totals.usageBytes / totals.quotaBytes) * 100;
    if (totals.percentUsed > QUOTA_WARN_PCT) {
      addIssue(
        issues,
        'over-quota-warning',
        'quota',
        `Origin uses ${totals.percentUsed.toFixed(1)}% of storage quota (>${QUOTA_WARN_PCT}%)`
      );
    }
  }

  const passed = issues.length === 0;
  return {
    page: pageUrl,
    entries,
    totals,
    issues,
    passed,
  };
}
