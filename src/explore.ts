import type { Page } from 'playwright';
import type { ExploreResult } from './types.js';

export interface ExploreOptions {
  maxClicks?: number;
  maxPages?: number;
  sameOrigin?: boolean;
}

export async function explore(page: Page, opts: ExploreOptions = {}): Promise<ExploreResult> {
  const maxClicks = opts.maxClicks ?? 50;
  const sameOrigin = opts.sameOrigin ?? true;
  const startOrigin = new URL(page.url()).origin;

  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];
  const errors: string[] = [];
  let buttonsClicked = 0;
  let formsSubmitted = 0;
  const pagesVisited = new Set<string>([page.url()]);

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('response', (res) => {
    if (res.status() >= 400) networkErrors.push(`${res.status()} ${res.url()}`);
  });

  for (let i = 0; i < maxClicks; i++) {
    const clickable = await page
      .locator('button:visible, a:visible, [role="button"]:visible')
      .all()
      .catch(() => []);
    if (clickable.length === 0) break;
    const target = clickable[i % clickable.length];
    if (!target) break;
    try {
      const before = page.url();
      await target.click({ timeout: 2000, trial: false });
      buttonsClicked++;
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
      const after = page.url();
      if (after !== before) {
        if (sameOrigin && new URL(after).origin !== startOrigin) {
          await page.goBack().catch(() => {});
        } else {
          pagesVisited.add(after);
        }
      }
    } catch (e) {
      // expected — many clicks fail (overlays, hidden, etc.)
    }
  }

  return {
    pagesVisited: pagesVisited.size,
    buttonsClicked,
    formsSubmitted,
    errors,
    consoleErrors,
    networkErrors,
  };
}
