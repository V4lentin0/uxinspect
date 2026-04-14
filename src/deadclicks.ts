import type { Page } from 'playwright';

export interface DeadClickOptions {
  maxElements?: number;
  waitAfterClickMs?: number;
}

export interface DeadClickFinding {
  selector: string;
  html: string;
  reason: 'no-mutation' | 'no-navigation' | 'no-network' | 'slow-feedback';
  feedbackMs?: number;
}

export interface DeadClickResult {
  page: string;
  clicked: number;
  findings: DeadClickFinding[];
  passed: boolean;
}

interface Candidate {
  selector: string;
  html: string;
}

export async function checkDeadClicks(page: Page, opts?: DeadClickOptions): Promise<DeadClickResult> {
  const maxElements = opts?.maxElements ?? 40;
  const waitAfterClickMs = opts?.waitAfterClickMs ?? 1500;

  const url = page.url();

  const candidates: Candidate[] = await page.$$eval(
    'button, a[href], [role=button], [onclick], [style]',
    (els: Element[], max: number) => {
      const results: { selector: string; html: string; inViewport: boolean }[] = [];

      for (const el of els) {
        const htmlEl = el as HTMLElement;

        // Skip submit buttons
        if ((el as HTMLInputElement).type === 'submit') continue;
        if (el.tagName === 'BUTTON' && (el as HTMLButtonElement).type === 'submit') continue;

        const style = window.getComputedStyle(htmlEl);
        const hasPointer = style.cursor === 'pointer';
        const isButton = el.tagName === 'BUTTON';
        const isLink = el.tagName === 'A' && el.hasAttribute('href');
        const isRoleButton = el.getAttribute('role') === 'button';
        const hasOnclick = el.hasAttribute('onclick');

        if (!hasPointer && !isButton && !isLink && !isRoleButton && !hasOnclick) continue;

        let selector = '';
        if (el.id) {
          selector = `#${CSS.escape(el.id)}`;
        } else if (el.getAttribute('data-testid')) {
          selector = `[data-testid="${el.getAttribute('data-testid')}"]`;
        } else {
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role');
          const text = el.textContent?.trim().slice(0, 20);
          if (role) {
            selector = text ? `[role="${role}"]:has-text("${text}")` : `[role="${role}"]`;
          } else {
            selector = text ? `${tag}:has-text("${text}")` : tag;
          }
        }

        const rect = htmlEl.getBoundingClientRect();
        const inViewport =
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.bottom <= window.innerHeight &&
          rect.right <= window.innerWidth;

        results.push({ selector, html: el.outerHTML.slice(0, 120), inViewport });
      }

      results.sort((a, b) => (a.inViewport === b.inViewport ? 0 : a.inViewport ? -1 : 1));
      return results.slice(0, max).map(({ selector, html }) => ({ selector, html }));
    },
    maxElements
  );

  const findings: DeadClickFinding[] = [];
  let clicked = 0;

  for (const candidate of candidates) {
    const { selector, html } = candidate;

    const baseHtmlLen: number = await page.evaluate(() => document.body.innerHTML.length);
    const baseUrl = page.url();

    let nets = 0;
    const reqHandler = () => { nets++; };
    page.on('request', reqHandler);

    try {
      await page.locator(selector).first().click({ timeout: 2000 });
      clicked++;
    } catch {
      page.off('request', reqHandler);
      continue;
    }

    const clickTime = Date.now();

    const feedbackMs: number = await page.evaluate(
      ({ wait, start }: { wait: number; start: number }) =>
        new Promise<number>((resolve) => {
          let resolved = false;
          const done = (ms: number) => {
            if (!resolved) {
              resolved = true;
              observer.disconnect();
              resolve(ms);
            }
          };
          const observer = new MutationObserver(() => done(Date.now() - start));
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
          });
          setTimeout(() => done(Date.now() - start), wait);
        }),
      { wait: waitAfterClickMs, start: clickTime }
    );

    const newHtmlLen: number = await page.evaluate(() => document.body.innerHTML.length);
    const newUrl = page.url();

    page.off('request', reqHandler);

    const urlChanged = newUrl !== baseUrl;
    const htmlChanged = newHtmlLen !== baseHtmlLen;
    const networkActivity = nets > 0;

    if (urlChanged) {
      await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    } else if (!htmlChanged && !networkActivity) {
      findings.push({ selector, html, reason: 'no-mutation' });
    } else if (feedbackMs > 500) {
      findings.push({ selector, html, reason: 'slow-feedback', feedbackMs });
    }
  }

  return {
    page: url,
    clicked,
    findings,
    passed: findings.length === 0,
  };
}
