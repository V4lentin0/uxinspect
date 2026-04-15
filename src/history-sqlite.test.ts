import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendHistoryEntry,
  loadHistory,
  migrateJsonDirToSqlite,
  renderHistoryHtml,
} from './history-timeline.js';
import type { InspectResult } from './types.js';

function makeResult(i: number, passed = true): InspectResult {
  const ts = new Date(Date.UTC(2026, 0, 1, 12, i, 0)).toISOString();
  const finished = new Date(Date.UTC(2026, 0, 1, 12, i, 5)).toISOString();
  const result = {
    url: 'https://example.com',
    startedAt: ts,
    finishedAt: finished,
    durationMs: 5000 + i * 100,
    passed,
    flows: [
      { name: 'home', passed, steps: [], screenshots: [] },
      { name: 'login', passed: passed && i % 2 === 0, steps: [], screenshots: [], error: passed ? undefined : 'boom' },
    ],
    perf: [
      {
        page: 'home',
        scores: { performance: 85 + i, accessibility: 90 + (i % 3), bestPractices: 90, seo: 92 },
        metrics: { lcp: 2000 + i * 50, cls: 0.01 + i * 0.001, tbt: 150 + i * 5, fcp: 900 + i * 10, si: 1400 + i * 20 },
      },
    ],
    a11y: [
      { page: 'home', passed: i !== 2, violations: i === 2 ? [{ id: 'color-contrast', impact: 'serious' as const, description: 'x', help: 'y', helpUrl: 'z', nodes: [] }] : [] },
    ],
    visual: [],
    consoleErrors: [],
  };
  return result as unknown as InspectResult;
}

function mkTmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'uxinspect-history-'));
  return {
    dir,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

test('write 5 entries to SQLite, read them back in order', async () => {
  const { dir, cleanup } = mkTmp();
  try {
    const dbPath = path.join(dir, 'history.db');
    for (let i = 0; i < 5; i++) {
      const id = await appendHistoryEntry(dbPath, makeResult(i));
      assert.ok(id > 0, 'insert returns positive id');
    }
    const runs = await loadHistory(dbPath);
    assert.equal(runs.length, 5);
    for (let i = 0; i < 5; i++) {
      assert.equal(runs[i].result.durationMs, 5000 + i * 100);
      assert.equal(runs[i].result.passed, true);
    }
  } finally {
    cleanup();
  }
});

test('trend computation: running pass count + average duration', async () => {
  const { dir, cleanup } = mkTmp();
  try {
    const dbPath = path.join(dir, 'history.db');
    for (let i = 0; i < 5; i++) {
      await appendHistoryEntry(dbPath, makeResult(i, i !== 3));
    }
    const runs = await loadHistory(dbPath);
    const total = runs.length;
    const passCount = runs.filter((r) => r.result.passed).length;
    const avgDuration = runs.reduce((s, r) => s + r.result.durationMs, 0) / total;
    assert.equal(total, 5);
    assert.equal(passCount, 4);
    assert.equal(Math.round(avgDuration), 5200);
  } finally {
    cleanup();
  }
});

test('renderHistoryHtml still produces sparklines + summary over SQLite data', async () => {
  const { dir, cleanup } = mkTmp();
  try {
    const dbPath = path.join(dir, 'history.db');
    for (let i = 0; i < 5; i++) {
      await appendHistoryEntry(dbPath, makeResult(i));
    }
    const runs = await loadHistory(dbPath);
    const html = renderHistoryHtml(runs, { title: 'test history', maxRuns: 10 });
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /test history/);
    // Summary block renders
    assert.match(html, /Total runs/);
    assert.match(html, /Pass rate/);
    // Sparklines render — polyline + circle elements
    assert.match(html, /<polyline /);
    assert.match(html, /<circle /);
    // Performance score card title present
    assert.match(html, /Performance score/);
    // Run rows
    assert.match(html, /<table class="runs">/);
  } finally {
    cleanup();
  }
});

test('migration: JSON dir auto-imports into SQLite, dedupes on repeat', async () => {
  const { dir, cleanup } = mkTmp();
  try {
    const jsonDir = path.join(dir, 'json');
    await fs.mkdir(jsonDir, { recursive: true });
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(
        path.join(jsonDir, `run-${i}.json`),
        JSON.stringify(makeResult(i)),
        'utf8',
      );
    }
    const dbPath = path.join(dir, '.uxinspect', 'history.db');

    const firstInserted = await migrateJsonDirToSqlite(jsonDir, dbPath);
    assert.equal(firstInserted, 3);

    const runs = await loadHistory(dbPath);
    assert.equal(runs.length, 3);
    // Ordered ascending
    assert.equal(runs[0].result.durationMs, 5000);
    assert.equal(runs[2].result.durationMs, 5200);

    // Second migration is a no-op (dedup by ts)
    const secondInserted = await migrateJsonDirToSqlite(jsonDir, dbPath);
    assert.equal(secondInserted, 0);
    const runs2 = await loadHistory(dbPath);
    assert.equal(runs2.length, 3);
  } finally {
    cleanup();
  }
});

test('loadHistory on legacy JSON dir still works (backward compatible)', async () => {
  const { dir, cleanup } = mkTmp();
  try {
    for (let i = 0; i < 2; i++) {
      await fs.writeFile(
        path.join(dir, `run-${i}.json`),
        JSON.stringify(makeResult(i)),
        'utf8',
      );
    }
    const runs = await loadHistory(dir);
    assert.equal(runs.length, 2);
    assert.equal(runs[0].result.durationMs, 5000);
    assert.equal(runs[1].result.durationMs, 5100);
  } finally {
    cleanup();
  }
});

test('appendHistoryEntry creates db + parent directory when missing', async () => {
  const { dir, cleanup } = mkTmp();
  try {
    const dbPath = path.join(dir, 'nested', 'sub', 'history.db');
    const id = await appendHistoryEntry(dbPath, makeResult(0));
    assert.ok(id > 0);
    const stat = await fs.stat(dbPath);
    assert.ok(stat.isFile());
    const runs = await loadHistory(dbPath);
    assert.equal(runs.length, 1);
  } finally {
    cleanup();
  }
});

test('loadHistory returns empty for missing sqlite path that looks like a db', async () => {
  const { dir, cleanup } = mkTmp();
  try {
    const dbPath = path.join(dir, 'nope.db');
    const runs = await loadHistory(dbPath);
    assert.deepEqual(runs, []);
  } finally {
    cleanup();
  }
});
