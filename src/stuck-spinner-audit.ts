import type { Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export interface StuckSpinnerOptions {
  /** Milliseconds a spinner must remain continuously visible to be flagged. Default: 5000. */
  timeoutMs?: number;
  /** CSS selectors to treat as loading indicators. Defaults to common spinner/skeleton patterns. */
  selectors?: string[];
  /** Polling interval in ms. Default: 250. */
  pollIntervalMs?: number;
  /** If true, capture a screenshot of the stuck state. Default: true. */
  captureScreenshot?: boolean;
  /** Directory for stuck-state screenshots. Default: `.uxinspect/stuck-spinners`. */
  screenshotDir?: string;
}

export interface StuckSpinnerFinding {
  selector: string;
  snippet: string;
  durationMs: number;
  screenshotPath?: string;
}

export interface StuckSpinnerResult {
  page: string;
  stuck: StuckSpinnerFinding[];
  checkedAt: string;
  durationMs: number;
  passed: boolean;
}

export const DEFAULT_STUCK_SPINNER_SELECTORS: readonly string[] = [
  '[aria-busy="true"]',
  '.spinner',
  '.loading',
  '.loader',
  '[role="progressbar"]',
  '[data-loading="true"]',
  '.skeleton',
  '.shimmer',
];

function sanitizeForFile(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 64);
}

/**
 * Audit a page for "stuck" loading indicators — elements matching any of the
 * configured selectors that remain visible continuously for longer than the
 * configured timeout. Useful to catch broken UI where a spinner never resolves.
 *
 * Strategy: poll `page.$$(selector)` every `pollIntervalMs` and track how long
 * each selector has been continuously visible. If the cumulative continuous
 * visibility exceeds `timeoutMs`, the selector is flagged as stuck and optionally
 * a screenshot of the stuck state is captured.
 */
export async function auditStuckSpinners(
  page: Page,
  opts: StuckSpinnerOptions = {},
): Promise<StuckSpinnerResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const selectors = opts.selectors && opts.selectors.length > 0 ? opts.selectors : [...DEFAULT_STUCK_SPINNER_SELECTORS];
  const pollIntervalMs = Math.max(25, opts.pollIntervalMs ?? 250);
  const captureScreenshot = opts.captureScreenshot ?? true;
  const screenshotDir = opts.screenshotDir ?? path.join('.uxinspect', 'stuck-spinners');

  const startedAt = Date.now();
  const url = page.url();

  // Track how long each selector has been continuously visible, and which
  // selectors have already been flagged so we don't double-report.
  const continuousVisibleSince = new Map<string, number>();
  const flagged = new Map<string, StuckSpinnerFinding>();

  // Slight safety buffer: poll for timeoutMs + 1 extra interval so we don't
  // miss a selector that becomes visible very close to the start.
  const overallDeadline = startedAt + timeoutMs + pollIntervalMs;

  while (Date.now() < overallDeadline) {
    const now = Date.now();
    for (const selector of selectors) {
      if (flagged.has(selector)) continue;
      const visible = await isAnyVisible(page, selector).catch(() => false);
      if (visible) {
        if (!continuousVisibleSince.has(selector)) {
          continuousVisibleSince.set(selector, now);
        }
        const since = continuousVisibleSince.get(selector) ?? now;
        const duration = now - since;
        if (duration >= timeoutMs) {
          const snippet = await firstVisibleSnippet(page, selector).catch(() => '');
          let screenshotPath: string | undefined;
          if (captureScreenshot) {
            try {
              await mkdir(screenshotDir, { recursive: true });
              const file = `${sanitizeForFile(selector)}-${Date.now()}.png`;
              const full = path.join(screenshotDir, file);
              await page.screenshot({ path: full, fullPage: false }).catch(() => {});
              screenshotPath = full;
            } catch {
              // best-effort screenshot; ignore failures
            }
          }
          flagged.set(selector, { selector, snippet, durationMs: duration, screenshotPath });
        }
      } else {
        // No longer visible — reset the continuous counter so we only flag
        // genuinely stuck (never-resolving) indicators, not repeatedly-briefly-visible ones.
        continuousVisibleSince.delete(selector);
      }
    }

    // Early exit if every selector has been flagged.
    if (flagged.size === selectors.length) break;

    await sleep(pollIntervalMs);
  }

  const finishedAt = Date.now();
  const stuck = Array.from(flagged.values());
  return {
    page: url,
    stuck,
    checkedAt: new Date(startedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    passed: stuck.length === 0,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isAnyVisible(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    try {
      const els = document.querySelectorAll(sel);
      for (const el of Array.from(els)) {
        const html = el as HTMLElement;
        const style = window.getComputedStyle(html);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        if (parseFloat(style.opacity || '1') === 0) continue;
        const rect = html.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, selector);
}

async function firstVisibleSnippet(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel) => {
    try {
      const els = document.querySelectorAll(sel);
      for (const el of Array.from(els)) {
        const html = el as HTMLElement;
        const style = window.getComputedStyle(html);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        if (parseFloat(style.opacity || '1') === 0) continue;
        const rect = html.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        return (html.outerHTML || '').slice(0, 200);
      }
      return '';
    } catch {
      return '';
    }
  }, selector);
}
