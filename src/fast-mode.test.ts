import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { InspectResult, ChecksConfig } from './types.js';
import {
  applyFastMode,
  fastModeWarning,
  FAST_MODE_SKIPPED_AUDITS,
  FAST_MODE_TARGET_MS,
} from './fast-mode.js';
import { writeReport } from './report.js';

test('applyFastMode — disables every slow audit and returns fresh checks object', () => {
  const input: ChecksConfig = {
    a11y: true,
    visual: true,
    perf: true,
    links: true,
    crawl: true,
    exposedPaths: true,
    bundleSize: true,
    tls: true,
    sitemap: true,
    redirects: true,
    compression: true,
    robotsAudit: true,
  };
  const { checks, skippedAudits } = applyFastMode(input);

  // Every slow audit is now explicitly false.
  for (const key of FAST_MODE_SKIPPED_AUDITS) {
    assert.equal(
      (checks as Record<string, unknown>)[key],
      false,
      `expected checks.${key} === false in fast mode`,
    );
  }

  // Non-slow audits are preserved untouched.
  assert.equal(checks.a11y, true);
  assert.equal(checks.visual, true);

  // Every slow audit that was enabled is reported as skipped.
  assert.equal(skippedAudits.length, FAST_MODE_SKIPPED_AUDITS.length);
  for (const key of FAST_MODE_SKIPPED_AUDITS) {
    assert.ok(skippedAudits.includes(key), `expected skippedAudits to include ${key}`);
  }

  // Input was not mutated (pure helper).
  assert.equal(input.perf, true);
  assert.equal(input.links, true);
});

test('applyFastMode — does not count audits that were already off', () => {
  const input: ChecksConfig = {
    a11y: true,
    visual: true,
    perf: false,
    links: false,
    crawl: false,
  };
  const { checks, skippedAudits } = applyFastMode(input);

  // Fast mode didn't actually take anything away, so the list stays empty.
  assert.deepEqual(skippedAudits, []);

  // But the keys are still explicitly false (idempotent).
  assert.equal(checks.perf, false);
  assert.equal(checks.links, false);
  assert.equal(checks.crawl, false);
});

test('applyFastMode — handles undefined checks input without throwing', () => {
  const { checks, skippedAudits } = applyFastMode(undefined);
  // Every slow audit forced off.
  for (const key of FAST_MODE_SKIPPED_AUDITS) {
    assert.equal(
      (checks as Record<string, unknown>)[key],
      false,
      `expected checks.${key} === false when called with undefined`,
    );
  }
  // No audits counted as skipped — undefined means "user never asked for it".
  assert.deepEqual(skippedAudits, []);
});

test('fastModeWarning — returns message only when duration > target', () => {
  assert.equal(fastModeWarning(5_000), undefined);
  assert.equal(fastModeWarning(FAST_MODE_TARGET_MS), undefined);
  const w = fastModeWarning(32_000);
  assert.ok(w, 'warning should be produced for 32s run');
  assert.match(w!, /Fast mode target exceeded/);
  assert.match(w!, /32\.0s/);
  assert.match(w!, /30s/);
});

test('writeReport — renders fast-mode banner and skipped audits list', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-fast-'));
  try {
    const result: InspectResult = {
      url: 'https://example.com',
      startedAt: '2026-04-14T00:00:00.000Z',
      finishedAt: '2026-04-14T00:00:28.000Z',
      durationMs: 28_000,
      flows: [{ name: 'load', passed: true, steps: [], screenshots: [] }],
      a11y: [{ page: 'https://example.com', violations: [], passed: true }],
      fastMeta: {
        skippedAudits: ['perf', 'links', 'crawl'],
        targetMs: FAST_MODE_TARGET_MS,
      },
      passed: true,
    };
    await writeReport(result, dir);
    const html = await fs.readFile(path.join(dir, 'report.html'), 'utf8');
    assert.match(html, /Fast mode/);
    assert.match(html, /perf/);
    assert.match(html, /links/);
    assert.match(html, /crawl/);
    assert.match(html, /skipped — fast mode/);
    // Under-budget runs should show the info pill, not the warning.
    assert.doesNotMatch(html, /target exceeded/);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test('writeReport — renders fast-mode warning when run exceeds target', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-fast-warn-'));
  try {
    const result: InspectResult = {
      url: 'https://example.com',
      startedAt: '2026-04-14T00:00:00.000Z',
      finishedAt: '2026-04-14T00:00:32.000Z',
      durationMs: 32_000,
      flows: [{ name: 'load', passed: true, steps: [], screenshots: [] }],
      fastMeta: {
        skippedAudits: ['perf'],
        targetMs: FAST_MODE_TARGET_MS,
        warning: 'Fast mode target exceeded (32.0s > 30s). Consider reducing flow count.',
      },
      passed: true,
    };
    await writeReport(result, dir);
    const html = await fs.readFile(path.join(dir, 'report.html'), 'utf8');
    assert.match(html, /target exceeded/);
    assert.match(html, /Fast mode target exceeded/);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test('writeReport — skips fast-mode section when fastMeta absent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-nofast-'));
  try {
    const result: InspectResult = {
      url: 'https://example.com',
      startedAt: '2026-04-14T00:00:00.000Z',
      finishedAt: '2026-04-14T00:00:01.000Z',
      durationMs: 1_000,
      flows: [{ name: 'load', passed: true, steps: [], screenshots: [] }],
      passed: true,
    };
    await writeReport(result, dir);
    const html = await fs.readFile(path.join(dir, 'report.html'), 'utf8');
    // Header should not appear without fastMeta.
    assert.doesNotMatch(html, /<h2>Fast mode<\/h2>/);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});
