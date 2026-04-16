/**
 * Clock-race / time-race audit.
 *
 * Detects UI elements that render relative time text (e.g. "just now",
 * "5 minutes ago") but do NOT react to the wall clock advancing.
 *
 * Uses Playwright's `page.clock` API:
 *   - `page.clock.install({ time })` freezes the clock at a known instant.
 *   - `page.clock.fastForward(duration)` advances wall-clock time without
 *     firing timers.
 *   - `page.clock.runFor(duration)` advances wall-clock time AND fires any
 *     queued timers (setInterval / setTimeout callbacks).
 *
 * Strategy per probe:
 *   1. Snapshot textContent of candidate elements that look like relative-time.
 *   2. Advance the clock via fastForward + runFor.
 *   3. Snapshot again.
 *   4. If the visible text still contains a relative-time phrase AND the
 *      text is unchanged, flag it as "relative-time-stuck".
 *      If the text moved backwards (e.g. "5 minutes ago" -> "2 minutes ago"
 *      after moving forward 24h), flag it as "relative-time-regressed".
 */

import type { Page } from 'playwright';

/** Matches common English relative-time phrases. */
export const RELATIVE_TIME_REGEX =
  /\b(?:just now|an?\s+(?:second|minute|hour|day|week|month|year)\s+ago|\d+\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s*ago|in\s+\d+\s*(?:seconds?|minutes?|hours?|days?))\b/i;

export interface ClockRaceAuditOptions {
  /**
   * How far to advance the clock. Either a duration string accepted by
   * Playwright's `page.clock.fastForward` (e.g. "24h", "30m", "1:10:00"),
   * or a number of milliseconds.
   * @default "24h"
   */
  fastForward?: string | number;
  /**
   * After advancing the clock, wait this many real milliseconds before
   * re-reading the DOM (gives microtasks / rAF a chance to settle).
   * @default 200
   */
  settleMs?: number;
  /**
   * Maximum number of candidate elements to probe.
   * @default 100
   */
  maxElements?: number;
  /**
   * If provided, restricts the probe to elements matching these selectors.
   * If omitted, the audit scans ALL visible text nodes on the page for
   * relative-time phrases.
   */
  selectors?: string[];
  /**
   * The fixed "now" instant the clock is installed at before probing.
   * Defaults to `new Date()` at audit start.
   */
  installAt?: Date;
}

export const DEFAULT_CLOCK_RACE_OPTIONS: Required<
  Omit<ClockRaceAuditOptions, 'selectors' | 'installAt'>
> = {
  fastForward: '24h',
  settleMs: 200,
  maxElements: 100,
};

export type ClockRaceIssueKind =
  | 'relative-time-stuck'
  | 'relative-time-regressed';

export interface ClockRaceIssue {
  kind: ClockRaceIssueKind;
  selector: string;
  /** Text before fast-forwarding. */
  textBefore: string;
  /** Text after fast-forwarding. */
  textAfter: string;
  /** Short snippet of outerHTML for the flagged element (trimmed). */
  snippet: string;
  message: string;
}

export interface ClockRaceResult {
  issues: ClockRaceIssue[];
  passed: boolean;
  /** Number of candidate elements actually probed. */
  probed: number;
  checkedAt: string;
}

interface Candidate {
  selector: string;
  text: string;
  snippet: string;
}

// Rough ordering of relative-time phrases from "newer" to "older" so we can
// detect backwards regressions after advancing forward.
const UNIT_ORDER: Record<string, number> = {
  second: 1,
  seconds: 1,
  minute: 60,
  minutes: 60,
  hour: 3600,
  hours: 3600,
  day: 86400,
  days: 86400,
  week: 604800,
  weeks: 604800,
  month: 2592000,
  months: 2592000,
  year: 31536000,
  years: 31536000,
};

/**
 * Estimate "seconds ago" represented by a relative-time phrase.
 * Returns null if no phrase was matched.
 */
function estimateAgoSeconds(text: string): number | null {
  if (/\bjust now\b/i.test(text)) return 0;
  const m = text.match(
    /\b(\d+)\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s*ago\b/i,
  );
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    const mult = UNIT_ORDER[unit];
    if (mult) return n * mult;
  }
  const m2 = text.match(
    /\ban?\s+(second|minute|hour|day|week|month|year)\s+ago\b/i,
  );
  if (m2) {
    const unit = m2[1].toLowerCase();
    const mult = UNIT_ORDER[unit];
    if (mult) return mult;
  }
  return null;
}

/**
 * Normalize a user-friendly duration (e.g. "24h", "30m", "15s", "2d", or a
 * raw number of milliseconds) into a form Playwright's clock accepts.
 * Playwright accepts: a number (ms), "mm:ss", or "hh:mm:ss".
 */
export function normalizeDuration(input: string | number): number {
  if (typeof input === 'number') return Math.max(0, Math.floor(input));
  const s = input.trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  // "hh:mm:ss" or "mm:ss"
  const colon = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (colon) {
    const a = parseInt(colon[1], 10);
    const b = parseInt(colon[2], 10);
    const c = colon[3] !== undefined ? parseInt(colon[3], 10) : null;
    if (c !== null) return (a * 3600 + b * 60 + c) * 1000; // hh:mm:ss
    return (a * 60 + b) * 1000; // mm:ss
  }
  // Suffix form: 2d, 24h, 30m, 15s, 500ms
  const suffix = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i);
  if (suffix) {
    const n = parseFloat(suffix[1]);
    const unit = suffix[2].toLowerCase();
    const mult =
      unit === 'ms'
        ? 1
        : unit === 's'
          ? 1000
          : unit === 'm'
            ? 60_000
            : unit === 'h'
              ? 3_600_000
              : 86_400_000;
    return Math.floor(n * mult);
  }
  throw new Error(
    `Invalid duration "${input}"; use ms number, "mm:ss", "hh:mm:ss", or suffixed form like "24h"/"30m"/"15s"/"2d".`,
  );
}

function truncate(s: string, n = 160): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

/**
 * Collect candidate elements that currently display relative-time text.
 * If `selectors` is provided, each selector is probed directly. Otherwise
 * the page is scanned via an in-page evaluation.
 */
async function collectCandidates(
  page: Page,
  options: ClockRaceAuditOptions,
): Promise<Candidate[]> {
  const maxElements =
    options.maxElements ?? DEFAULT_CLOCK_RACE_OPTIONS.maxElements;
  const regexSrc = RELATIVE_TIME_REGEX.source;
  const regexFlags = RELATIVE_TIME_REGEX.flags;

  if (options.selectors && options.selectors.length > 0) {
    const out: Candidate[] = [];
    for (const selector of options.selectors) {
      if (out.length >= maxElements) break;
      const handles = await page.$$(selector);
      for (const h of handles) {
        if (out.length >= maxElements) break;
        try {
          const visible = await h.isVisible().catch(() => false);
          if (!visible) continue;
          const text = ((await h.textContent()) ?? '').trim();
          if (!text) continue;
          if (!new RegExp(regexSrc, regexFlags).test(text)) continue;
          const snippet = truncate(
            (await h.evaluate((el: Element) => (el as HTMLElement).outerHTML)) ??
              '',
          );
          out.push({ selector, text, snippet });
        } catch {
          // ignore individual element failures
        }
      }
    }
    return out;
  }

  // No selectors: scan the DOM in-page.
  const raw = await page.evaluate(
    ({ regexSrc, regexFlags, maxElements }) => {
      const re = new RegExp(regexSrc, regexFlags);
      const results: Array<{ selector: string; text: string; snippet: string }> =
        [];
      const elements = Array.from(document.querySelectorAll<HTMLElement>('*'));
      for (const el of elements) {
        if (results.length >= maxElements) break;
        // Only consider elements whose OWN direct text (not descendant
        // concatenation) contains a relative-time phrase. This prevents
        // flagging a whole <body>.
        let ownText = '';
        for (const child of Array.from(el.childNodes)) {
          if (child.nodeType === Node.TEXT_NODE) {
            ownText += child.textContent ?? '';
          }
        }
        ownText = ownText.trim();
        if (!ownText || !re.test(ownText)) continue;
        // Visibility check.
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden')
          continue;

        // Build a reasonably unique selector.
        let selector: string;
        if (el.id) {
          selector = `#${CSS.escape(el.id)}`;
        } else {
          const tag = el.tagName.toLowerCase();
          const cls = el.className && typeof el.className === 'string'
            ? el.className
                .trim()
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 2)
                .map((c) => '.' + CSS.escape(c))
                .join('')
            : '';
          selector = tag + cls;
        }
        const snippet = (el.outerHTML || '').slice(0, 160);
        results.push({ selector, text: ownText, snippet });
      }
      return results;
    },
    { regexSrc, regexFlags, maxElements },
  );
  return raw;
}

/**
 * Run the clock-race audit.
 */
export async function runClockRaceAudit(
  page: Page,
  opts: ClockRaceAuditOptions = {},
): Promise<ClockRaceResult> {
  const fastForward = opts.fastForward ?? DEFAULT_CLOCK_RACE_OPTIONS.fastForward;
  const settleMs = opts.settleMs ?? DEFAULT_CLOCK_RACE_OPTIONS.settleMs;
  const installAt = opts.installAt ?? new Date();

  // Install a frozen clock so subsequent fastForward / runFor operates on a
  // well-defined baseline. If install fails (already installed, unsupported),
  // we still try to proceed.
  try {
    await page.clock.install({ time: installAt });
  } catch {
    // ignore — page may already have a clock installed by the caller.
  }

  // Give the page a moment to render with the installed clock.
  await page.waitForTimeout(50);

  const candidates = await collectCandidates(page, opts);

  // Normalize the user-facing duration string ("24h", "30m", etc.) into
  // milliseconds, which Playwright's clock API accepts directly.
  const advanceMs = normalizeDuration(fastForward);

  // Advance the clock two ways so both "passive" (stale) and "active"
  // (setInterval-driven) UIs get a fair chance to update.
  //   - fastForward: bumps Date.now() instantly, skipping queued timers.
  //   - runFor: bumps Date.now() AND fires queued timers along the way.
  // We run fastForward first to expose passive/stale widgets, then runFor
  // (capped to a smaller slice) to let any reactive widgets catch up.
  try {
    await page.clock.fastForward(advanceMs);
  } catch {
    // Swallow: caller's clock may not be installed; we still re-read DOM.
  }
  try {
    // runFor with the full advance can be expensive (fires every queued
    // timer). We cap to 5s of virtual time which is enough for a typical
    // 1s setInterval to tick several times, without blowing up on long
    // fast-forwards that would fire thousands of intervals.
    const runSlice = Math.min(advanceMs, 5_000);
    await page.clock.runFor(runSlice);
  } catch {
    // same as above.
  }

  await page.waitForTimeout(settleMs);

  const issues: ClockRaceIssue[] = [];

  for (const c of candidates) {
    // Re-read the element's current textContent. We do this via selector
    // rather than caching a handle because the DOM may have been replaced.
    let afterText: string | null = null;
    try {
      const handle = await page.$(c.selector);
      if (handle) {
        afterText = ((await handle.textContent()) ?? '').trim();
      }
    } catch {
      afterText = null;
    }

    if (afterText === null) {
      // Element disappeared after advancing the clock — treat as reactive.
      continue;
    }

    const stillHasRelative = RELATIVE_TIME_REGEX.test(afterText);

    if (afterText === c.text && stillHasRelative) {
      issues.push({
        kind: 'relative-time-stuck',
        selector: c.selector,
        textBefore: c.text,
        textAfter: afterText,
        snippet: c.snippet,
        message: `Element text "${truncate(c.text, 60)}" did not update after advancing the clock by ${String(fastForward)}; relative-time display appears stuck.`,
      });
      continue;
    }

    const beforeSec = estimateAgoSeconds(c.text);
    const afterSec = estimateAgoSeconds(afterText);
    if (
      beforeSec !== null &&
      afterSec !== null &&
      afterSec < beforeSec &&
      stillHasRelative
    ) {
      issues.push({
        kind: 'relative-time-regressed',
        selector: c.selector,
        textBefore: c.text,
        textAfter: afterText,
        snippet: c.snippet,
        message: `Element text moved backwards after advancing the clock: "${truncate(c.text, 60)}" -> "${truncate(afterText, 60)}".`,
      });
    }
  }

  return {
    issues,
    passed: issues.length === 0,
    probed: candidates.length,
    checkedAt: new Date().toISOString(),
  };
}
