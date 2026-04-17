/**
 * human-pass-screenshot.ts
 *
 * Shared infra for P6 #54 (human-pass) — consistent naming + path capture so
 * test harnesses and the main audit emit screenshots in the exact same shape.
 *
 * Every screenshot captured through a recorder is written to the target dir
 * with a zero-padded, monotonic counter prefix and a kebab-cased tag. This
 * guarantees deterministic ordering and identical filenames whether the
 * screenshots are produced by the production human-pass runner or by unit
 * tests that exercise the same recorder.
 *
 * Filename shape:
 *   01-login-form.png
 *   02-dashboard.png
 *   ...
 *   99-last-two-digit.png
 *   100-overflow.png   (3-digit once counter exceeds 99)
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';

export interface ScreenshotRecorderOptions {
  dir: string; // absolute target dir
  prefix?: string; // default '' — optional category tag
}

export interface ScreenshotRecorder {
  capture(
    tag: string,
    page: Page,
    opts?: { fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number } },
  ): Promise<string>;
  paths(): readonly string[];
  count(): number;
}

/**
 * Sanitize an arbitrary string into a kebab-cased slug:
 * lowercase, replace non-alphanumeric with `-`, collapse consecutive dashes,
 * trim leading/trailing dashes. Returns `step` if the result is empty.
 */
export function kebab(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length === 0 ? 'step' : slug;
}

/**
 * Create a screenshot recorder rooted at `opts.dir`. Ensures the directory
 * exists before returning. The recorder maintains a monotonic counter so every
 * capture gets a unique, sortable filename.
 */
export async function createRecorder(opts: ScreenshotRecorderOptions): Promise<ScreenshotRecorder> {
  await mkdir(opts.dir, { recursive: true });

  const prefix = opts.prefix ?? '';
  const captured: string[] = [];
  let counter = 0;

  const pad = (n: number): string => {
    if (n > 99) {
      return String(n).padStart(3, '0');
    }
    return String(n).padStart(2, '0');
  };

  const buildName = (tag: string, n: number): string => {
    const slug = kebab(tag);
    const body = prefix.length > 0 ? `${kebab(prefix)}-${slug}` : slug;
    return `${pad(n)}-${body}.png`;
  };

  return {
    async capture(tag, page, captureOpts) {
      counter += 1;
      const filename = buildName(tag, counter);
      const path = join(opts.dir, filename);
      await page.screenshot({
        path,
        fullPage: captureOpts?.fullPage ?? true,
        clip: captureOpts?.clip,
      });
      captured.push(path);
      return path;
    },
    paths() {
      return captured.slice();
    },
    count() {
      return captured.length;
    },
  };
}
