/**
 * P5 #46 — tests for the consolidated frontend playbook resolver.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAYBOOK_ENTRIES,
  applyPlaybookChecks,
  formatPlaybook,
} from './playbook.js';
import type { ChecksConfig } from './types.js';

test('PLAYBOOK_ENTRIES: non-empty, unique, documented', () => {
  assert.ok(PLAYBOOK_ENTRIES.length >= 50, 'playbook should cover at least 50 gates');
  const seen = new Set<string>();
  for (const e of PLAYBOOK_ENTRIES) {
    assert.ok(!seen.has(String(e.check)), `duplicate entry: ${String(e.check)}`);
    seen.add(String(e.check));
    assert.ok(e.catches.length >= 10, `entry ${String(e.check)} missing rationale`);
  }
});

test('applyPlaybookChecks: turns on every gate when caller passed nothing', () => {
  const out = applyPlaybookChecks(undefined);
  for (const e of PLAYBOOK_ENTRIES) {
    assert.equal((out as Record<string, unknown>)[e.check], true, `${String(e.check)} not enabled`);
  }
});

test('applyPlaybookChecks: respects caller-provided explicit disables', () => {
  const input: ChecksConfig = { visual: false, a11y: true };
  const out = applyPlaybookChecks(input);
  assert.equal(out.visual, false, 'explicit --no-visual must survive');
  assert.equal(out.a11y, true, 'explicit --a11y must survive');
  // Other gates still flipped on.
  assert.equal(out.keyboard, true);
  assert.equal(out.forms, true);
});

test('applyPlaybookChecks: does NOT enable backend-only gates that are not in the playbook', () => {
  const out = applyPlaybookChecks(undefined);
  // Pure backend / infra gates are excluded from the FE playbook.
  for (const excluded of ['tls', 'sitemap', 'robotsAudit', 'mixedContent', 'redirects', 'exposedPaths', 'crawl', 'compression', 'cacheHeaders']) {
    assert.equal((out as Record<string, unknown>)[excluded], undefined, `${excluded} should NOT be auto-enabled by the playbook`);
  }
});

test('applyPlaybookChecks: caller passing an existing config is returned as a new object', () => {
  const input: ChecksConfig = { a11y: true };
  const out = applyPlaybookChecks(input);
  assert.notStrictEqual(out, input, 'must not mutate caller config');
  assert.equal(input.visual, undefined, 'caller config unchanged');
});

test('formatPlaybook: renders header + one line per entry', () => {
  const out = formatPlaybook();
  assert.match(out, /frontend playbook/);
  assert.match(out, new RegExp(`${PLAYBOOK_ENTRIES.length} gates`));
  for (const e of PLAYBOOK_ENTRIES) {
    assert.ok(out.includes(String(e.check)), `playbook list missing ${String(e.check)}`);
  }
});
