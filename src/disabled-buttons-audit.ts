import type { Page } from 'playwright';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface DisabledButtonsOptions {
  selectors?: string[];
  maxButtons?: number;
  waitAfterClickMs?: number;
  screenshotDir?: string;
}

export type DisabledButtonResponseKind = 'url' | 'console' | 'network' | 'dom';

export interface DisabledButtonFinding {
  selector: string;
  snippet: string;
  what: DisabledButtonResponseKind;
  evidence: string;
  screenshot?: string;
}

export interface DisabledButtonsResult {
  page: string;
  checked: number;
  responded: DisabledButtonFinding[];
  passed: boolean;
  skipped?: { reason: 'too-many-buttons'; total: number; max: number };
}

interface Candidate {
  selector: string;
  snippet: string;
}

const DEFAULT_SELECTORS = ['[disabled]', '[aria-disabled="true"]'];
const INTERACTIVE_TAGS = new Set(['BUTTON', 'A']);
const INTERACTIVE_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'image']);

export async function auditDisabledButtons(
  page: Page,
  opts?: DisabledButtonsOptions,
): Promise<DisabledButtonsResult> {
  const selectors = opts?.selectors && opts.selectors.length ? opts.selectors : DEFAULT_SELECTORS;
  const maxButtons = opts?.maxButtons ?? 50;
  const waitAfterClickMs = opts?.waitAfterClickMs ?? 500;
  const screenshotDir = opts?.screenshotDir;
  const url = page.url();

  const selectorList = selectors;

  const candidates: Candidate[] = await page.evaluate(
    (args: { selectorList: string[]; max: number }) => {
      const { selectorList, max } = args;
      const interactiveTags = new Set(['BUTTON', 'A']);
      const interactiveInputTypes = new Set(['button', 'submit', 'reset', 'image']);
      const seen = new Set<Element>();
      const out: { selector: string; snippet: string }[] = [];

      const isInteractive = (el: Element): boolean => {
        if (interactiveTags.has(el.tagName)) return true;
        if (el.tagName === 'INPUT') {
          const t = (el as HTMLInputElement).type?.toLowerCase();
          if (t && interactiveInputTypes.has(t)) return true;
        }
        const role = el.getAttribute('role');
        if (role === 'button' || role === 'link' || role === 'menuitem') return true;
        return false;
      };

      const buildSelector = (el: Element, idx: number): string => {
        if (el.id) return `#${CSS.escape(el.id)}`;
        const testid = el.getAttribute('data-testid');
        if (testid) return `[data-testid="${CSS.escape(testid)}"]`;
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role');
        if (role) return `${tag}[role="${role}"]:nth-of-type(${idx + 1})`;
        return `${tag}:nth-of-type(${idx + 1})`;
      };

      for (const sel of selectorList) {
        let nodes: NodeListOf<Element>;
        try {
          nodes = document.querySelectorAll(sel);
        } catch {
          continue;
        }
        let i = 0;
        for (const el of Array.from(nodes)) {
          if (seen.has(el)) {
            i++;
            continue;
          }
          seen.add(el);
          if (!isInteractive(el)) {
            i++;
            continue;
          }
          const selector = buildSelector(el, i);
          const snippet = el.outerHTML.slice(0, 200);
          out.push({ selector, snippet });
          i++;
          if (out.length >= max + 1) return out;
        }
      }
      return out;
    },
    { selectorList, max: maxButtons },
  );

  if (candidates.length > maxButtons) {
    return {
      page: url,
      checked: 0,
      responded: [],
      passed: true,
      skipped: { reason: 'too-many-buttons', total: candidates.length, max: maxButtons },
    };
  }

  await page.evaluate(() => {
    const w = window as unknown as { __uxiDisabledMutations?: number };
    w.__uxiDisabledMutations = 0;
    const observer = new MutationObserver((mutations) => {
      let count = 0;
      for (const m of mutations) {
        if (m.type === 'childList') count += m.addedNodes.length + m.removedNodes.length;
        else if (m.type === 'attributes') count += 1;
        else if (m.type === 'characterData') count += 1;
      }
      w.__uxiDisabledMutations = (w.__uxiDisabledMutations ?? 0) + count;
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    (w as unknown as { __uxiDisabledObserver?: MutationObserver }).__uxiDisabledObserver = observer;
  });

  const consoleErrors: string[] = [];
  const onConsole = (msg: import('playwright').ConsoleMessage) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      consoleErrors.push(msg.text());
    }
  };
  const pageErrors: string[] = [];
  const onPageError = (e: Error) => {
    pageErrors.push(e.message);
  };
  const networkRequests: string[] = [];
  const onRequest = (req: import('playwright').Request) => {
    networkRequests.push(req.url());
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('request', onRequest);

  const responded: DisabledButtonFinding[] = [];
  let checked = 0;

  try {
    for (const cand of candidates) {
      checked++;
      const baseUrl = page.url();
      const baseConsole = consoleErrors.length;
      const basePageErr = pageErrors.length;
      const baseNet = networkRequests.length;

      const baseMutations: number = await page.evaluate(() => {
        const w = window as unknown as { __uxiDisabledMutations?: number };
        const v = w.__uxiDisabledMutations ?? 0;
        w.__uxiDisabledMutations = 0;
        return v;
      });
      void baseMutations;

      let locator;
      try {
        locator = page.locator(cand.selector).first();
      } catch {
        continue;
      }

      try {
        await locator.click({ force: true, timeout: 2000, noWaitAfter: true });
      } catch {
        // element might be detached / not clickable even with force — skip
        continue;
      }

      await page.waitForTimeout(waitAfterClickMs);

      const newMutations: number = await page
        .evaluate(() => {
          const w = window as unknown as { __uxiDisabledMutations?: number };
          return w.__uxiDisabledMutations ?? 0;
        })
        .catch(() => 0);

      const newUrl = page.url();
      const urlChanged = newUrl !== baseUrl;
      const consoleDelta = consoleErrors.length - baseConsole;
      const pageErrDelta = pageErrors.length - basePageErr;
      const netDelta = networkRequests.length - baseNet;
      const domDelta = newMutations; // reset above, so current counter is the delta

      // DOM threshold: 3+ mutations counts as "significant" — forced click alone
      // typically fires 0. Focus / blur can cause trivial attribute tweaks.
      const domSignificant = domDelta >= 3;

      let found: DisabledButtonFinding | undefined;
      if (urlChanged) {
        found = {
          selector: cand.selector,
          snippet: cand.snippet,
          what: 'url',
          evidence: `URL changed from ${baseUrl} to ${newUrl}`,
        };
        // attempt to restore URL so subsequent selectors still resolve
        await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
      } else if (netDelta > 0) {
        found = {
          selector: cand.selector,
          snippet: cand.snippet,
          what: 'network',
          evidence: `${netDelta} network request(s) fired: ${networkRequests
            .slice(baseNet, baseNet + Math.min(3, netDelta))
            .join(', ')}`,
        };
      } else if (consoleDelta > 0 || pageErrDelta > 0) {
        const msgs = [
          ...consoleErrors.slice(baseConsole),
          ...pageErrors.slice(basePageErr),
        ];
        found = {
          selector: cand.selector,
          snippet: cand.snippet,
          what: 'console',
          evidence: `${consoleDelta + pageErrDelta} console/page error(s): ${msgs
            .slice(0, 2)
            .join(' | ')}`,
        };
      } else if (domSignificant) {
        found = {
          selector: cand.selector,
          snippet: cand.snippet,
          what: 'dom',
          evidence: `${domDelta} DOM mutation(s) after click`,
        };
      }

      if (found) {
        if (screenshotDir) {
          try {
            await fs.mkdir(screenshotDir, { recursive: true });
            const safe = cand.selector.replace(/[^a-z0-9]/gi, '_').slice(0, 60) || `btn-${checked}`;
            const shotPath = path.join(screenshotDir, `disabled-${checked}-${safe}.png`);
            await locator.screenshot({ path: shotPath }).catch(async () => {
              await page.screenshot({ path: shotPath, fullPage: false }).catch(() => {});
            });
            found.screenshot = shotPath;
          } catch {
            // non-fatal
          }
        }
        responded.push(found);
      }
    }
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('request', onRequest);
    await page
      .evaluate(() => {
        const w = window as unknown as {
          __uxiDisabledObserver?: MutationObserver;
          __uxiDisabledMutations?: number;
        };
        w.__uxiDisabledObserver?.disconnect();
        delete w.__uxiDisabledObserver;
        delete w.__uxiDisabledMutations;
      })
      .catch(() => {});
  }

  return {
    page: url,
    checked,
    responded,
    passed: responded.length === 0,
  };
}
