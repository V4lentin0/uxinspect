import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LocatorCache,
  hashKey,
  readCacheStats,
  clearCache,
} from './locator-cache.js';
import { AIHelper } from './ai.js';
import { Driver } from './driver.js';

function mkTmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'uxinspect-loc-cache-'));
  return {
    dir,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

test('hashKey is stable across calls and varies with url/viewport', () => {
  const base = { instruction: 'click Sign up', url: 'https://example.com/', viewport: 'desktop' };
  const k1 = hashKey(base);
  const k2 = hashKey(base);
  assert.equal(k1, k2, 'same input produces same hash');
  const k3 = hashKey({ ...base, viewport: 'mobile' });
  assert.notEqual(k1, k3, 'different viewport produces different hash');
  const k4 = hashKey({ ...base, url: 'https://example.com/login' });
  assert.notEqual(k1, k4, 'different url produces different hash');
  const k5 = hashKey({ ...base, instruction: 'click Log in' });
  assert.notEqual(k1, k5, 'different instruction produces different hash');
  // URL fragment is stripped — should not affect hash
  const k6 = hashKey({ ...base, url: 'https://example.com/#section' });
  const k7 = hashKey({ ...base, url: 'https://example.com/' });
  assert.equal(k6, k7, 'url fragment is stripped');
});

test('LocatorCache (sqlite) persists entries + stats across instances', async () => {
  const { dir, cleanup } = mkTmp();
  try {
    const dbPath = path.join(dir, 'history.db');
    const cache1 = new LocatorCache({ dbPath });
    await cache1.load();

    const key = hashKey({ instruction: 'click sign up', url: 'https://x', viewport: 'desktop' });
    cache1.put({
      key,
      resolvedSelector: 'sign-up',
      confidence: 0.95,
      strategy: 'testid',
      verb: 'click',
    });
    // Register a hit + miss so stats travel too.
    assert.ok(cache1.get(key));
    cache1.recordMiss();
    const s1 = cache1.getStats();
    assert.equal(s1.hits, 1);
    assert.equal(s1.misses, 1);
    assert.equal(s1.size, 1);
    await cache1.save();

    // Second instance reads the same db.
    const cache2 = new LocatorCache({ dbPath });
    await cache2.load();
    const entry = cache2.get(key);
    assert.ok(entry, 'entry survived process boundary');
    assert.equal(entry?.resolvedSelector, 'sign-up');
    assert.equal(entry?.strategy, 'testid');
    assert.equal(entry?.confidence, 0.95);

    const s2 = cache2.getStats();
    // cache2.get() incremented hits once more.
    assert.equal(s2.hits, 2, 'hit counter survived + incremented after load');
    assert.equal(s2.misses, 1);
    assert.equal(s2.size, 1);
  } finally {
    cleanup();
  }
});

test('LocatorCache LRU eviction caps size and bumps eviction counter', async () => {
  const { dir, cleanup } = mkTmp();
  try {
    const dbPath = path.join(dir, 'history.db');
    const cache = new LocatorCache({ dbPath, maxEntries: 3 });
    await cache.load();

    const now = Date.now();
    // Oldest first.
    cache.put({ key: 'k1', resolvedSelector: 's1', confidence: 0.8, strategy: 'testid', verb: 'click', lastUsed: now - 4000 });
    cache.put({ key: 'k2', resolvedSelector: 's2', confidence: 0.8, strategy: 'testid', verb: 'click', lastUsed: now - 3000 });
    cache.put({ key: 'k3', resolvedSelector: 's3', confidence: 0.8, strategy: 'testid', verb: 'click', lastUsed: now - 2000 });
    assert.equal(cache.getStats().size, 3);
    assert.equal(cache.getStats().evictions, 0);

    // Fourth insert must evict the LRU (k1).
    cache.put({ key: 'k4', resolvedSelector: 's4', confidence: 0.8, strategy: 'testid', verb: 'click', lastUsed: now - 1000 });
    assert.equal(cache.getStats().size, 3);
    assert.equal(cache.getStats().evictions, 1);
    assert.equal(cache.get('k1'), null, 'k1 was evicted (oldest)');
    assert.ok(cache.get('k4'), 'k4 remains');

    await cache.save();
    const stats = await readCacheStats(dbPath);
    assert.equal(stats.size, 3);
    assert.equal(stats.evictions, 1);
  } finally {
    cleanup();
  }
});

test('LocatorCache JSON fallback round-trips when no dbPath is provided', async () => {
  const { dir, cleanup } = mkTmp();
  try {
    const jsonPath = path.join(dir, 'locator-cache.json');
    const cache = new LocatorCache({ jsonPath });
    await cache.load();
    const key = hashKey({ instruction: 'click save', url: 'https://y', viewport: 'mobile' });
    cache.put({
      key,
      resolvedSelector: '#save-btn',
      confidence: 0.85,
      strategy: 'css',
      verb: 'click',
    });
    await cache.save();

    const raw = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
    assert.ok(Array.isArray(raw.entries), 'json file has entries array');
    assert.equal(raw.entries.length, 1);
    assert.equal(raw.entries[0].resolvedSelector, '#save-btn');
    assert.equal(raw.entries[0].strategy, 'css');

    const cache2 = new LocatorCache({ jsonPath });
    await cache2.load();
    assert.ok(cache2.get(key), 'reloaded from json');
  } finally {
    cleanup();
  }
});

test('readCacheStats + clearCache CLI helpers work on an empty / populated db', async () => {
  const { dir, cleanup } = mkTmp();
  try {
    const dbPath = path.join(dir, 'history.db');
    // Missing db -> zeroed stats, no throw.
    const empty = await readCacheStats(dbPath);
    assert.deepEqual(empty, { hits: 0, misses: 0, evictions: 0, size: 0 });

    const cache = new LocatorCache({ dbPath });
    await cache.load();
    cache.put({ key: 'a', resolvedSelector: 'x', confidence: 0.9, strategy: 'testid', verb: 'click' });
    cache.put({ key: 'b', resolvedSelector: 'y', confidence: 0.9, strategy: 'testid', verb: 'click' });
    cache.get('a');
    cache.get('missing-key');
    await cache.save();

    const after = await readCacheStats(dbPath);
    assert.equal(after.size, 2);
    assert.ok(after.hits >= 1);
    assert.ok(after.misses >= 1);

    await clearCache(dbPath);
    const cleared = await readCacheStats(dbPath);
    assert.deepEqual(cleared, { hits: 0, misses: 0, evictions: 0, size: 0 });
  } finally {
    cleanup();
  }
});

test('AIHelper uses cache on repeat act() + validates stale entries on real page', async () => {
  const { dir, cleanup } = mkTmp();
  try {
    const dbPath = path.join(dir, 'history.db');
    const driver = new Driver();
    await driver.launch({ headless: true });
    const page = await driver.newPage();
    await page.setContent(`
      <html><body>
        <button data-testid="save-btn">Save</button>
      </body></html>
    `);
    const ai = new AIHelper({ locatorCacheDbPath: dbPath, keyContext: { url: 'about:blank', viewport: 'test' } });
    await ai.init(page);

    assert.equal(await ai.act('click save'), true, 'first act succeeds (miss)');
    const afterFirst = ai.getCacheStats();
    assert.equal(afterFirst.misses, 1);
    assert.equal(afterFirst.hits, 0);
    assert.ok(afterFirst.size >= 1, 'cache stored the resolved locator');

    assert.equal(await ai.act('click save'), true, 'second act succeeds (hit)');
    const afterSecond = ai.getCacheStats();
    assert.ok(afterSecond.hits >= 1, 'cache hit recorded');

    // Replace the DOM so the cached selector no longer matches — act must
    // invalidate and fall through to a fresh resolve.
    await page.setContent('<html><body><button id="different">Save</button></body></html>');
    assert.equal(await ai.act('click save'), true, 'stale entry falls through to resolver');

    await ai.close();
    await driver.close();

    // Persisted to disk and readable by the CLI helper.
    const stats = await readCacheStats(dbPath);
    assert.ok(stats.size >= 1);
    assert.ok(stats.hits >= 1);
  } finally {
    cleanup();
  }
});
