/**
 * P5 #46 — tests for the consolidated backend playbook resolver.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKEND_PLAYBOOK_ENTRIES,
  applyBackendPlaybookChecks,
  formatBackendPlaybook,
} from './playbook-backend.js';
import type { ChecksConfig } from './types.js';

test('BACKEND_PLAYBOOK_ENTRIES: non-empty, unique, documented', () => {
  assert.ok(BACKEND_PLAYBOOK_ENTRIES.length >= 20, 'backend playbook should cover at least 20 gates');
  const seen = new Set<string>();
  for (const e of BACKEND_PLAYBOOK_ENTRIES) {
    assert.ok(!seen.has(String(e.check)), `duplicate entry: ${String(e.check)}`);
    seen.add(String(e.check));
    assert.ok(e.catches.length >= 10, `entry ${String(e.check)} missing rationale`);
  }
});

test('applyBackendPlaybookChecks: turns on every gate when caller passed nothing', () => {
  const out = applyBackendPlaybookChecks(undefined);
  for (const e of BACKEND_PLAYBOOK_ENTRIES) {
    assert.equal((out as Record<string, unknown>)[e.check], true, `${String(e.check)} not enabled`);
  }
});

test('applyBackendPlaybookChecks: respects caller-provided explicit disables', () => {
  const input: ChecksConfig = { tls: false, security: true };
  const out = applyBackendPlaybookChecks(input);
  assert.equal(out.tls, false, 'explicit --no-tls must survive');
  assert.equal(out.security, true, 'explicit --security must survive');
  // Other gates still flipped on.
  assert.equal(out.sitemap, true);
  assert.equal(out.robotsAudit, true);
});

test('applyBackendPlaybookChecks: does NOT enable frontend-only gates that are not in the backend playbook', () => {
  const out = applyBackendPlaybookChecks(undefined);
  // Pure frontend gates are excluded from the backend playbook.
  for (const excluded of ['a11y', 'visual', 'keyboard', 'focusTrap', 'xss', 'clockRace', 'jitter', 'srAnnouncements', 'pseudoLocale', 'perf', 'lcpElement']) {
    assert.equal((out as Record<string, unknown>)[excluded], undefined, `${excluded} should NOT be auto-enabled by the playbook`);
  }
});

test('applyBackendPlaybookChecks: caller passing an existing config is returned as a new object', () => {
  const input: ChecksConfig = { tls: true };
  const out = applyBackendPlaybookChecks(input);
  assert.notStrictEqual(out, input, 'must not mutate caller config');
  assert.equal(input.security, undefined, 'caller config unchanged');
});

test('formatBackendPlaybook: renders header + one line per entry', () => {
  const out = formatBackendPlaybook();
  assert.match(out, /backend playbook/);
  assert.match(out, new RegExp(`${BACKEND_PLAYBOOK_ENTRIES.length} gates`));
  for (const e of BACKEND_PLAYBOOK_ENTRIES) {
    assert.ok(out.includes(String(e.check)), `playbook list missing ${String(e.check)}`);
  }
});

test('applyBackendPlaybookChecks enables humanPassBackend as the last entry', () => {
  assert.equal(
    BACKEND_PLAYBOOK_ENTRIES[BACKEND_PLAYBOOK_ENTRIES.length - 1].check,
    'humanPassBackend',
    'humanPassBackend must be the final backend playbook entry',
  );
  const out = applyBackendPlaybookChecks(undefined);
  assert.equal(
    (out as Record<string, unknown>).humanPassBackend,
    true,
    'humanPassBackend must be enabled when caller passes nothing',
  );
});
