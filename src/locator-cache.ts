import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Locator cache — Stagehand-inspired persistent cache of resolved locators.
//
// Skips redundant heuristic / LLM-based locator resolution for repeat inputs.
// Keyed by a stable hash of (instruction, url, viewport). On a cache hit, the
// caller re-resolves the stored Playwright selector; if it no longer resolves,
// the hit is discarded and a fresh resolution runs (and the new result is
// stored back, overwriting the stale entry).
//
// Storage: a table in `.uxinspect/history.db` (reuses better-sqlite3 already
// loaded by the history module) so the cache shares a single SQLite file with
// the rest of the run data. A JSON file is kept as a fallback for callers that
// prefer not to pull the native binding (e.g. very small CLI invocations).
//
// Entry shape matches the Stagehand contract:
//   { key, resolvedSelector, confidence, lastUsed, hits, strategy, verb }
// ---------------------------------------------------------------------------

export interface CacheEntry {
  key: string;
  resolvedSelector: string;
  /** 0..1 confidence in the stored selector. Heuristic hits use strategy-specific defaults. */
  confidence: number;
  /** Epoch ms of last read or write. Used for LRU eviction. */
  lastUsed: number;
  /** Monotonically increasing hit counter for stats. */
  hits: number;
  /** Resolver strategy — lets the caller re-hydrate the Playwright Locator. */
  strategy: 'testid' | 'css' | 'role' | 'text' | 'label' | 'placeholder' | 'title';
  /** Verb the selector was stored against (click/fill/etc). */
  verb: string;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
}

export interface LocatorCacheOptions {
  /** Absolute path to SQLite db (e.g. `.uxinspect/history.db`). */
  dbPath?: string;
  /** Absolute path to JSON fallback (e.g. `.uxinspect/locator-cache.json`). */
  jsonPath?: string;
  /** Maximum entries before LRU eviction kicks in. Default 10_000. */
  maxEntries?: number;
}

export interface HashInput {
  instruction: string;
  url?: string;
  viewport?: string;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const TABLE = 'locator_cache';
const STATS_TABLE = 'locator_cache_stats';
const STATS_ROW_ID = 1;

type BetterSqliteStatement = {
  run: (...params: unknown[]) => { lastInsertRowid: number | bigint; changes: number };
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
};

type BetterSqliteDatabase = {
  prepare: (sql: string) => BetterSqliteStatement;
  transaction: <T extends (...args: any[]) => any>(fn: T) => T;
  pragma: (s: string) => unknown;
  close: () => void;
} & { [key: string]: unknown };

type BetterSqliteCtor = new (filename: string) => BetterSqliteDatabase;

let _sqliteCtor: BetterSqliteCtor | null = null;
async function getSqliteCtor(): Promise<BetterSqliteCtor> {
  if (_sqliteCtor) return _sqliteCtor;
  const mod = await import('better-sqlite3');
  const candidate = (mod.default ?? mod) as unknown;
  _sqliteCtor = candidate as BetterSqliteCtor;
  return _sqliteCtor;
}

function runDdl(db: BetterSqliteDatabase, sql: string): void {
  const fn = db['exec'] as (s: string) => void;
  fn.call(db, sql);
}

/** Stable SHA-256 hash of (instruction + url + viewport). */
export function hashKey(input: HashInput): string {
  const payload = JSON.stringify({
    i: input.instruction.trim().toLowerCase(),
    u: (input.url ?? '').replace(/#.*$/, ''),
    v: input.viewport ?? '',
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/**
 * Persistent locator cache. Defaults to SQLite backing when `dbPath` is set
 * (shared with `.uxinspect/history.db`) and JSON otherwise. Instances are
 * cheap — state lives on disk; a small in-memory map is used to keep the hot
 * path synchronous for a single `act()` call.
 */
export class LocatorCache {
  private mem = new Map<string, CacheEntry>();
  private stats: CacheStats = { hits: 0, misses: 0, evictions: 0, size: 0 };
  private readonly maxEntries: number;
  private loaded = false;

  constructor(private readonly opts: LocatorCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** Load persisted entries + stats from disk. Safe to call repeatedly. */
  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.opts.dbPath) await this.loadSqlite();
    else if (this.opts.jsonPath) await this.loadJson();
    this.stats.size = this.mem.size;
    this.loaded = true;
  }

  private async loadSqlite(): Promise<void> {
    if (!this.opts.dbPath) return;
    await fs.mkdir(path.dirname(this.opts.dbPath), { recursive: true });
    const Ctor = await getSqliteCtor();
    const db = new Ctor(this.opts.dbPath);
    try {
      ensureLocatorSchema(db);
      const rows = db
        .prepare(
          `SELECT key, resolved_selector, confidence, last_used, hits, strategy, verb
           FROM ${TABLE}`,
        )
        .all() as Array<{
          key: string;
          resolved_selector: string;
          confidence: number;
          last_used: number;
          hits: number;
          strategy: string;
          verb: string;
        }>;
      for (const r of rows) {
        this.mem.set(r.key, {
          key: r.key,
          resolvedSelector: r.resolved_selector,
          confidence: r.confidence,
          lastUsed: r.last_used,
          hits: r.hits,
          strategy: r.strategy as CacheEntry['strategy'],
          verb: r.verb,
        });
      }
      const statRow = db
        .prepare(`SELECT hits, misses, evictions FROM ${STATS_TABLE} WHERE id = ?`)
        .get(STATS_ROW_ID) as { hits: number; misses: number; evictions: number } | undefined;
      if (statRow) {
        this.stats.hits = statRow.hits;
        this.stats.misses = statRow.misses;
        this.stats.evictions = statRow.evictions;
      }
    } finally {
      db.close();
    }
  }

  private async loadJson(): Promise<void> {
    if (!this.opts.jsonPath) return;
    try {
      const raw = await fs.readFile(this.opts.jsonPath, 'utf8');
      const data = JSON.parse(raw) as {
        entries?: CacheEntry[];
        stats?: Partial<CacheStats>;
      };
      for (const e of data.entries ?? []) this.mem.set(e.key, e);
      if (data.stats) {
        this.stats.hits = data.stats.hits ?? 0;
        this.stats.misses = data.stats.misses ?? 0;
        this.stats.evictions = data.stats.evictions ?? 0;
      }
    } catch {
      /* missing file is fine */
    }
  }

  /** Look up a cache entry by hashed key. Touches `lastUsed`/`hits` on a hit. */
  get(key: string): CacheEntry | null {
    const entry = this.mem.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }
    entry.lastUsed = Date.now();
    entry.hits++;
    this.stats.hits++;
    return entry;
  }

  /** Record a miss without a subsequent `put()` (e.g. resolver returned null). */
  recordMiss(): void {
    this.stats.misses++;
  }

  /** Insert or overwrite an entry. Evicts LRU when over capacity. */
  put(entry: Omit<CacheEntry, 'lastUsed' | 'hits'> & Partial<Pick<CacheEntry, 'lastUsed' | 'hits'>>): CacheEntry {
    const full: CacheEntry = {
      key: entry.key,
      resolvedSelector: entry.resolvedSelector,
      confidence: entry.confidence,
      strategy: entry.strategy,
      verb: entry.verb,
      lastUsed: entry.lastUsed ?? Date.now(),
      hits: entry.hits ?? 0,
    };
    this.mem.set(full.key, full);
    while (this.mem.size > this.maxEntries) this.evictOne();
    this.stats.size = this.mem.size;
    return full;
  }

  /** Drop an entry (e.g. validation found the cached selector no longer matches). */
  invalidate(key: string): void {
    if (this.mem.delete(key)) {
      this.stats.size = this.mem.size;
    }
  }

  /** Read-only view of current stats. */
  getStats(): CacheStats {
    return { ...this.stats, size: this.mem.size };
  }

  /** Remove all entries and reset counters. */
  clear(): void {
    this.mem.clear();
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.evictions = 0;
    this.stats.size = 0;
  }

  /** Persist entries + stats back to disk. Safe to call repeatedly. */
  async save(): Promise<void> {
    if (this.opts.dbPath) await this.saveSqlite();
    else if (this.opts.jsonPath) await this.saveJson();
  }

  private async saveSqlite(): Promise<void> {
    if (!this.opts.dbPath) return;
    await fs.mkdir(path.dirname(this.opts.dbPath), { recursive: true });
    const Ctor = await getSqliteCtor();
    const db = new Ctor(this.opts.dbPath);
    try {
      ensureLocatorSchema(db);
      const upsert = db.prepare(
        `INSERT INTO ${TABLE}
           (key, resolved_selector, confidence, last_used, hits, strategy, verb)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           resolved_selector=excluded.resolved_selector,
           confidence=excluded.confidence,
           last_used=excluded.last_used,
           hits=excluded.hits,
           strategy=excluded.strategy,
           verb=excluded.verb`,
      );
      const del = db.prepare(`DELETE FROM ${TABLE} WHERE key NOT IN (SELECT key FROM ${TABLE})`);
      const existing = db.prepare(`SELECT key FROM ${TABLE}`).all() as Array<{ key: string }>;
      const keepSet = new Set(this.mem.keys());
      const tx = db.transaction(() => {
        for (const e of this.mem.values()) {
          upsert.run(e.key, e.resolvedSelector, e.confidence, e.lastUsed, e.hits, e.strategy, e.verb);
        }
        for (const r of existing) {
          if (!keepSet.has(r.key)) {
            db.prepare(`DELETE FROM ${TABLE} WHERE key = ?`).run(r.key);
          }
        }
        db.prepare(
          `INSERT INTO ${STATS_TABLE} (id, hits, misses, evictions)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             hits=excluded.hits,
             misses=excluded.misses,
             evictions=excluded.evictions`,
        ).run(STATS_ROW_ID, this.stats.hits, this.stats.misses, this.stats.evictions);
      });
      tx();
      // `del` is declared for parity with older schema sweeps but unused when
      // a per-key DELETE runs inside the transaction. Reference it so strict
      // lints don't flag the binding.
      void del;
    } finally {
      db.close();
    }
  }

  private async saveJson(): Promise<void> {
    if (!this.opts.jsonPath) return;
    await fs.mkdir(path.dirname(this.opts.jsonPath), { recursive: true });
    const payload = {
      entries: Array.from(this.mem.values()),
      stats: {
        hits: this.stats.hits,
        misses: this.stats.misses,
        evictions: this.stats.evictions,
      },
    };
    await fs.writeFile(this.opts.jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  }

  private evictOne(): void {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [k, v] of this.mem) {
      if (v.lastUsed < oldestTs) {
        oldestTs = v.lastUsed;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) {
      this.mem.delete(oldestKey);
      this.stats.evictions++;
    }
  }
}

function ensureLocatorSchema(db: BetterSqliteDatabase): void {
  runDdl(
    db,
    `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      key TEXT PRIMARY KEY,
      resolved_selector TEXT NOT NULL,
      confidence REAL NOT NULL,
      last_used INTEGER NOT NULL,
      hits INTEGER NOT NULL DEFAULT 0,
      strategy TEXT NOT NULL,
      verb TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_last_used ON ${TABLE}(last_used);

    CREATE TABLE IF NOT EXISTS ${STATS_TABLE} (
      id INTEGER PRIMARY KEY,
      hits INTEGER NOT NULL DEFAULT 0,
      misses INTEGER NOT NULL DEFAULT 0,
      evictions INTEGER NOT NULL DEFAULT 0
    );
    `,
  );
}

/**
 * Convenience helper for the CLI `cache stats` subcommand. Reads raw counters
 * + row count from SQLite without constructing a full LocatorCache.
 */
export async function readCacheStats(dbPath: string): Promise<CacheStats> {
  try {
    await fs.stat(dbPath);
  } catch {
    return { hits: 0, misses: 0, evictions: 0, size: 0 };
  }
  const Ctor = await getSqliteCtor();
  const db = new Ctor(dbPath);
  try {
    ensureLocatorSchema(db);
    const row = db
      .prepare(`SELECT hits, misses, evictions FROM ${STATS_TABLE} WHERE id = ?`)
      .get(STATS_ROW_ID) as { hits: number; misses: number; evictions: number } | undefined;
    const count = (db.prepare(`SELECT COUNT(*) as c FROM ${TABLE}`).get() as { c: number }).c;
    return {
      hits: row?.hits ?? 0,
      misses: row?.misses ?? 0,
      evictions: row?.evictions ?? 0,
      size: count,
    };
  } finally {
    db.close();
  }
}

/** Remove every cached entry + reset counters on disk. */
export async function clearCache(dbPath: string): Promise<void> {
  const Ctor = await getSqliteCtor();
  const db = new Ctor(dbPath);
  try {
    ensureLocatorSchema(db);
    db.prepare(`DELETE FROM ${TABLE}`).run();
    db.prepare(`DELETE FROM ${STATS_TABLE}`).run();
  } finally {
    db.close();
  }
}
