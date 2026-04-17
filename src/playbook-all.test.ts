/**
 * Tests for the combined FE+BE playbook resolver.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_PLAYBOOK_ENTRIES,
  applyAllPlaybookChecks,
  formatAllPlaybook,
} from './playbook-all.js';
import { PLAYBOOK_ENTRIES } from './playbook.js';
import { BACKEND_PLAYBOOK_ENTRIES } from './playbook-backend.js';
import type { ChecksConfig } from './types.js';

test('ALL_PLAYBOOK_ENTRIES: non-empty, unique, documented', () => {
  assert.ok(
    ALL_PLAYBOOK_ENTRIES.length >= PLAYBOOK_ENTRIES.length,
    `combined playbook should cover at least ${PLAYBOOK_ENTRIES.length} gates`,
  );
  assert.ok(ALL_PLAYBOOK_ENTRIES.length >= 78, 'combined playbook should cover at least 78 gates');
  const seen = new Set<string>();
  for (const e of ALL_PLAYBOOK_ENTRIES) {
    assert.ok(!seen.has(String(e.check)), `duplicate entry: ${String(e.check)}`);
    seen.add(String(e.check));
    assert.ok(e.catches.length >= 10, `entry ${String(e.check)} missing rationale`);
  }
});

test('ALL_PLAYBOOK_ENTRIES: contains every FE entry', () => {
  const combined = new Set(ALL_PLAYBOOK_ENTRIES.map((e) => String(e.check)));
  for (const e of PLAYBOOK_ENTRIES) {
    assert.ok(
      combined.has(String(e.check)),
      `combined playbook missing FE entry: ${String(e.check)}`,
    );
  }
});

test('ALL_PLAYBOOK_ENTRIES: contains every BE entry not colliding with FE', () => {
  const combined = new Set(ALL_PLAYBOOK_ENTRIES.map((e) => String(e.check)));
  for (const e of BACKEND_PLAYBOOK_ENTRIES) {
    assert.ok(
      combined.has(String(e.check)),
      `combined playbook missing BE entry: ${String(e.check)}`,
    );
  }
});

test('applyAllPlaybookChecks: turns on every gate when caller passed nothing', () => {
  const out = applyAllPlaybookChecks(undefined);
  for (const e of ALL_PLAYBOOK_ENTRIES) {
    assert.equal(
      (out as Record<string, unknown>)[e.check],
      true,
      `${String(e.check)} not enabled`,
    );
  }
});

test('applyAllPlaybookChecks: respects explicit disables', () => {
  const input: ChecksConfig = { visual: false, tls: false } as ChecksConfig;
  const out = applyAllPlaybookChecks(input);
  assert.equal((out as Record<string, unknown>).visual, false, 'explicit --no-visual must survive');
  assert.equal((out as Record<string, unknown>).tls, false, 'explicit --no-tls must survive');
  // Other gates flipped on.
  assert.equal((out as Record<string, unknown>).keyboard, true);
  assert.equal((out as Record<string, unknown>).forms, true);
});

test('applyAllPlaybookChecks: caller passing an existing config is returned as a new object', () => {
  const input: ChecksConfig = { a11y: true };
  const out = applyAllPlaybookChecks(input);
  assert.notStrictEqual(out, input, 'must not mutate caller config');
  assert.equal(input.visual, undefined, 'caller config unchanged');
});

test('formatAllPlaybook: renders combined header + line per entry', () => {
  const out = formatAllPlaybook();
  assert.match(out, /full playbook/);
  assert.match(out, new RegExp(`${ALL_PLAYBOOK_ENTRIES.length} gates`));
  for (const e of ALL_PLAYBOOK_ENTRIES) {
    assert.ok(out.includes(String(e.check)), `playbook list missing ${String(e.check)}`);
  }
});
