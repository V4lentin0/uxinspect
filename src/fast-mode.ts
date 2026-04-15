/**
 * Fast inner-loop mode (P3 #31).
 *
 * `--fast` skips slow audits, forces parallelization, pins to chromium, and
 * targets sub-30-second wall-clock runs so watch-mode dev loops stay snappy.
 *
 * The list below identifies every audit known to dominate run time:
 * - `perf`         — Lighthouse spawns its own controlled context (~10–30s)
 * - `links`        — broken-link crawler, fetches every <a href>
 * - `crawl`        — multi-page site walker
 * - `exposedPaths` — probes a list of sensitive URLs
 * - `bundleSize`   — downloads + analyses every JS/CSS asset
 * - `tls`          — extra TLS handshake roundtrip
 * - `sitemap`      — fetches sitemap.xml + sampled URLs
 * - `redirects`    — follows redirect chains end-to-end
 * - `compression`  — issues HEAD/GET on every resource
 * - `robotsAudit`  — fetches robots.txt
 *
 * Returning a fresh `checks` object keeps the helper pure so it is trivially
 * testable and re-usable by anything that wants to reason about which audits
 * fast mode disables (cli output, report rendering, future watch hooks).
 */

import type { ChecksConfig } from './types.js';

/** Audits we always skip in fast mode — the SLOW set. */
export const FAST_MODE_SKIPPED_AUDITS = [
  'perf',
  'links',
  'crawl',
  'exposedPaths',
  'bundleSize',
  'tls',
  'sitemap',
  'redirects',
  'compression',
  'robotsAudit',
] as const satisfies readonly (keyof ChecksConfig)[];

/** Wall-clock target for fast-mode runs (ms). */
export const FAST_MODE_TARGET_MS = 30_000;

export interface FastModeApply {
  /** New checks config with slow audits forced off. */
  checks: ChecksConfig;
  /** Audits the helper actually disabled (subset of FAST_MODE_SKIPPED_AUDITS that were truthy or undefined-but-on-via-all). */
  skippedAudits: string[];
}

/**
 * Apply fast-mode rules to a `ChecksConfig`. Pure: never mutates the input.
 *
 * Behaviour:
 * - Sets every audit in `FAST_MODE_SKIPPED_AUDITS` to `false`.
 * - Records which of those were previously truthy/undefined-with-all so the
 *   caller can surface them to users (cli / html report).
 *
 * `undefined` is treated as "may be on if `--all` was passed" — we conservatively
 * count it as skipped so the report does not lie about what fast mode did.
 */
export function applyFastMode(checks: ChecksConfig | undefined): FastModeApply {
  const next: ChecksConfig = { ...(checks ?? {}) };
  const skipped: string[] = [];
  for (const key of FAST_MODE_SKIPPED_AUDITS) {
    const prev = (checks ?? {})[key];
    // Skip if previously truthy. We do NOT count undefined here — if the audit
    // wasn't requested, fast mode didn't actually take anything away.
    if (prev !== undefined && prev !== false) {
      skipped.push(key);
    }
    (next as Record<string, unknown>)[key] = false;
  }
  return { checks: next, skippedAudits: skipped };
}

/**
 * Build the human-readable warning emitted when a fast-mode run blows past the
 * 30s budget. Returns `undefined` when the run came in under target.
 */
export function fastModeWarning(durationMs: number, targetMs: number = FAST_MODE_TARGET_MS): string | undefined {
  if (durationMs <= targetMs) return undefined;
  const actual = (durationMs / 1000).toFixed(1);
  const target = (targetMs / 1000).toFixed(0);
  return `Fast mode target exceeded (${actual}s > ${target}s). Consider reducing flow count.`;
}
