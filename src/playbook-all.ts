/**
 * P6 #53 — Consolidated frontend + backend playbook: one flag that enables
 * every relevant uxinspect gate (FE playbook + BE playbook) in a single pass.
 *
 * The `--playbook-all` flag turns on the full gate set so the caller never has
 * to remember which frontend vs. backend toggles to stack. Caller's explicit
 * `--no-<check>` opt-outs are preserved — the playbook only fills gaps.
 *
 * Entries are deduped by `check`: the frontend playbook wins on collision, FE
 * order is preserved, and any backend entry that does not collide is appended
 * in BE order.
 */
import { PLAYBOOK_ENTRIES, type PlaybookEntry } from './playbook.js';
import { BACKEND_PLAYBOOK_ENTRIES } from './playbook-backend.js';
import type { ChecksConfig } from './types.js';

/**
 * Concatenation of frontend + backend playbook entries, deduped by `check`.
 * FE wins on collision; FE order is preserved, then BE entries that don't
 * collide are appended in BE order.
 */
export const ALL_PLAYBOOK_ENTRIES: readonly PlaybookEntry[] = (() => {
  const seen = new Set<keyof ChecksConfig>();
  const merged: PlaybookEntry[] = [];
  for (const entry of PLAYBOOK_ENTRIES) {
    if (!seen.has(entry.check)) {
      seen.add(entry.check);
      merged.push(entry);
    }
  }
  for (const entry of BACKEND_PLAYBOOK_ENTRIES) {
    if (!seen.has(entry.check)) {
      seen.add(entry.check);
      merged.push(entry);
    }
  }
  return merged;
})();

/**
 * Merge consolidated playbook-enabled checks onto whatever the caller already
 * set. Any check the caller explicitly enabled or disabled wins — the playbook
 * only fills in gaps. This lets `--playbook-all --no-visual` work intuitively.
 */
export function applyAllPlaybookChecks(existing: ChecksConfig | undefined): ChecksConfig {
  const next: ChecksConfig = { ...(existing ?? {}) };
  for (const entry of ALL_PLAYBOOK_ENTRIES) {
    if (next[entry.check] === undefined) {
      (next as Record<string, unknown>)[entry.check] = true;
    }
  }
  return next;
}

/**
 * Pretty-print the consolidated playbook coverage map for CLI
 * `--playbook-all --list` so the user can see every gate that will run and
 * what each catches.
 */
export function formatAllPlaybook(): string {
  const width = Math.max(...ALL_PLAYBOOK_ENTRIES.map((e) => e.check.length));
  const lines = [
    `uxinspect full playbook (frontend + backend) — ${ALL_PLAYBOOK_ENTRIES.length} gates`,
    '',
    ...ALL_PLAYBOOK_ENTRIES.map(
      (e) => `  ${String(e.check).padEnd(width)}  ${e.catches}`,
    ),
  ];
  return lines.join('\n');
}
