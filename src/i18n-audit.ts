import type { Page } from 'playwright';

export type MissingKeyKind =
  | 'placeholder-syntax'
  | 'all-screaming-snake'
  | 'bracket-unknown'
  | 'dot-path'
  | 'handlebars';

export interface MissingKeyHit {
  kind: MissingKeyKind;
  text: string;
  target?: string;
}

export type RtlIssueKind =
  | 'html-dir-not-rtl'
  | 'body-text-align-left'
  | 'mirrorable-icon-not-flipped';

export interface RtlIssue {
  kind: RtlIssueKind;
  detail: string;
  target?: string;
}

export interface OverflowHit {
  locale: string;
  target: string;
  tag: string;
  text: string;
  scrollWidth: number;
  clientWidth: number;
}

export interface I18nAuditOptions {
  locales?: string[];
  checks?: {
    missingKeys?: boolean;
    rtlLayout?: boolean;
    overflow?: boolean;
  };
  /** Max visible-text samples scanned for missing-key patterns. */
  maxTextNodes?: number;
  /** Max overflow hits reported per locale. */
  maxOverflowPerLocale?: number;
}

export interface I18nResult {
  page: string;
  localesChecked: string[];
  missingKeys: MissingKeyHit[];
  rtlIssues: RtlIssue[];
  overflowing: OverflowHit[];
  passed: boolean;
}

const DEFAULT_LOCALES = ['de-DE', 'ru-RU', 'ar-SA', 'ja-JP'];

/**
 * Audit a page for i18n defects across three axes:
 *   1. Missing translation keys leaking into the UI (raw IDs rendered as text).
 *   2. RTL layout breakage when the page is loaded with an Arabic locale.
 *   3. Text overflow when long-translation locales are applied (de/ru/ar/ja).
 *
 * The same `Page` object is reused for all non-RTL checks. The RTL and
 * per-locale overflow checks create short-lived contexts off the browser
 * so they don't mutate the caller's session.
 */
export async function auditI18n(page: Page, opts: I18nAuditOptions = {}): Promise<I18nResult> {
  const url = page.url();
  const checks = {
    missingKeys: opts.checks?.missingKeys ?? true,
    rtlLayout: opts.checks?.rtlLayout ?? true,
    overflow: opts.checks?.overflow ?? true,
  };
  const locales = opts.locales ?? DEFAULT_LOCALES;
  const maxTextNodes = opts.maxTextNodes ?? 400;
  const maxOverflowPerLocale = opts.maxOverflowPerLocale ?? 40;

  const missingKeys: MissingKeyHit[] = checks.missingKeys
    ? await scanMissingKeys(page, maxTextNodes)
    : [];

  const rtlIssues: RtlIssue[] = checks.rtlLayout
    ? await scanRtlLayout(page).catch(() => [])
    : [];

  const overflowing: OverflowHit[] = [];
  if (checks.overflow) {
    for (const locale of locales) {
      const hits = await scanOverflowForLocale(page, url, locale, maxOverflowPerLocale).catch(
        () => [] as OverflowHit[],
      );
      overflowing.push(...hits);
    }
  }

  return {
    page: url,
    localesChecked: checks.overflow ? locales : [],
    missingKeys,
    rtlIssues,
    overflowing,
    passed:
      missingKeys.length === 0 && rtlIssues.length === 0 && overflowing.length === 0,
  };
}

// -------------------------------------------------------------------------
// 1. Missing translation keys
// -------------------------------------------------------------------------

async function scanMissingKeys(page: Page, maxTextNodes: number): Promise<MissingKeyHit[]> {
  return await page.evaluate((limit) => {
    type Kind =
      | 'placeholder-syntax'
      | 'all-screaming-snake'
      | 'bracket-unknown'
      | 'dot-path'
      | 'handlebars';
    interface Hit {
      kind: Kind;
      text: string;
      target?: string;
    }

    function buildSelector(el: Element | null): string | undefined {
      if (!el) return undefined;
      const tag = el.tagName.toLowerCase();
      const id = (el as HTMLElement).id ? `#${(el as HTMLElement).id}` : '';
      const cls = el.classList[0] ? `.${el.classList[0]}` : '';
      return `${tag}${id}${cls}`;
    }

    function isVisible(el: Element): boolean {
      const style = window.getComputedStyle(el as HTMLElement);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = (el as HTMLElement).getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    // Patterns that indicate a translation placeholder leaked into the rendered text.
    const patterns: { kind: Kind; re: RegExp }[] = [
      // {{ tr.Y }} or {{ t('key') }}
      { kind: 'handlebars', re: /\{\{\s*[a-zA-Z_$][\w.$]*\s*(?:\([^)]*\))?\s*\}\}/ },
      // {i18n.X} or {t.key}
      { kind: 'placeholder-syntax', re: /\{(?:i18n|t|tr|trans|translate)\.[A-Za-z_][\w.]*\}/ },
      // [unknown] literal leaks (i18next default for missing keys)
      { kind: 'bracket-unknown', re: /\[unknown\]/i },
      // t.key or tr.key literally rendered as standalone text (e.g. "t.welcome")
      { kind: 'dot-path', re: /^\s*(?:t|tr|i18n|trans)\.[A-Za-z_][\w.]*\s*$/ },
    ];
    // ALL.SCREAMING.SNAKE.CASE keys rendered as-is, e.g. "USER.WELCOME.TITLE"
    const screamingRe = /^[A-Z][A-Z0-9_]+(?:\.[A-Z][A-Z0-9_]+){1,}$/;

    const hits: Hit[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    let scanned = 0;
    while ((node = walker.nextNode())) {
      if (scanned >= limit) break;
      scanned++;
      const raw = node.nodeValue ?? '';
      const text = raw.trim();
      if (!text || text.length > 400) continue;
      const parent = (node as Text).parentElement;
      if (!parent) continue;
      const tag = parent.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') continue;
      if (!isVisible(parent)) continue;

      const target = buildSelector(parent);
      let matched = false;
      for (const { kind, re } of patterns) {
        if (re.test(text)) {
          hits.push({ kind, text: text.slice(0, 200), target });
          matched = true;
          break;
        }
      }
      if (!matched && screamingRe.test(text)) {
        hits.push({ kind: 'all-screaming-snake', text: text.slice(0, 200), target });
      }
    }
    return hits;
  }, maxTextNodes);
}

// -------------------------------------------------------------------------
// 2. RTL layout
// -------------------------------------------------------------------------

async function scanRtlLayout(page: Page): Promise<RtlIssue[]> {
  const url = page.url();
  if (!url || url === 'about:blank') return [];

  const browser = page.context().browser();
  if (!browser) return [];

  const ctx = await browser.newContext({
    locale: 'ar-SA',
    extraHTTPHeaders: { 'Accept-Language': 'ar-SA,ar;q=0.9' },
    viewport: page.viewportSize() ?? { width: 1280, height: 800 },
  });
  try {
    const p = await ctx.newPage();
    try {
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch {
      return [];
    }

    return await p.evaluate(() => {
      type Kind = 'html-dir-not-rtl' | 'body-text-align-left' | 'mirrorable-icon-not-flipped';
      interface Issue {
        kind: Kind;
        detail: string;
        target?: string;
      }
      function buildSelector(el: Element): string {
        const tag = el.tagName.toLowerCase();
        const id = (el as HTMLElement).id ? `#${(el as HTMLElement).id}` : '';
        const cls = el.classList[0] ? `.${el.classList[0]}` : '';
        return `${tag}${id}${cls}`;
      }
      const issues: Issue[] = [];
      const html = document.documentElement;
      const htmlDir = (html.getAttribute('dir') ?? '').toLowerCase();
      const computedHtmlDir = window.getComputedStyle(html).direction;
      if (htmlDir !== 'rtl' && computedHtmlDir !== 'rtl') {
        issues.push({
          kind: 'html-dir-not-rtl',
          detail: `Arabic locale loaded but <html dir> is "${htmlDir || '(unset)'}" (computed direction: ${computedHtmlDir})`,
        });
      }
      const bodyAlign = window.getComputedStyle(document.body).textAlign;
      // In an RTL doc, text-align: left is almost always a bug (authored for LTR).
      if ((htmlDir === 'rtl' || computedHtmlDir === 'rtl') && bodyAlign === 'left') {
        issues.push({
          kind: 'body-text-align-left',
          detail: 'document is RTL but body text-align computes to "left"',
        });
      }

      // Chevron / arrow icons that should be mirrored under RTL.
      // Look for class names or aria-labels that imply a directional icon and
      // check whether the element applies an RTL-aware transform/scaleX.
      const mirrorableHints = [
        'chevron-right',
        'chevron-left',
        'arrow-right',
        'arrow-left',
        'caret-right',
        'caret-left',
      ];
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[class*="chevron"], [class*="arrow"], [class*="caret"], [aria-label*="arrow"], [aria-label*="chevron"], [aria-label*="caret"]',
        ),
      ).slice(0, 50);
      for (const el of candidates) {
        const cls = (el.getAttribute('class') ?? '').toLowerCase();
        const label = (el.getAttribute('aria-label') ?? '').toLowerCase();
        const hint = mirrorableHints.find((h) => cls.includes(h) || label.includes(h));
        if (!hint) continue;
        const cs = window.getComputedStyle(el);
        const transform = cs.transform;
        // Detect either a scaleX(-1) or a rotateY(180deg) — both mirror the element.
        const mirrored =
          /matrix\(-1/.test(transform) ||
          /matrix3d\(-1/.test(transform) ||
          /scaleX\(-1\)/.test(transform);
        if (!mirrored) {
          issues.push({
            kind: 'mirrorable-icon-not-flipped',
            detail: `"${hint}" icon is not mirrored under RTL (transform: ${transform})`,
            target: buildSelector(el),
          });
        }
      }
      return issues;
    });
  } finally {
    await ctx.close().catch(() => {});
  }
}

// -------------------------------------------------------------------------
// 3. Per-locale overflow
// -------------------------------------------------------------------------

async function scanOverflowForLocale(
  page: Page,
  url: string,
  locale: string,
  maxHits: number,
): Promise<OverflowHit[]> {
  if (!url || url === 'about:blank') {
    // Overflow can still be measured on the current page.
    return measureOverflow(page, locale, maxHits);
  }
  const browser = page.context().browser();
  if (!browser) return [];
  const ctx = await browser.newContext({
    locale,
    extraHTTPHeaders: { 'Accept-Language': `${locale},${locale.split('-')[0]};q=0.9` },
    viewport: page.viewportSize() ?? { width: 1280, height: 800 },
  });
  try {
    const p = await ctx.newPage();
    try {
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch {
      return [];
    }
    return await measureOverflow(p, locale, maxHits);
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function measureOverflow(
  page: Page,
  locale: string,
  maxHits: number,
): Promise<OverflowHit[]> {
  return await page.evaluate(
    ({ localeArg, limit }) => {
      interface Hit {
        locale: string;
        target: string;
        tag: string;
        text: string;
        scrollWidth: number;
        clientWidth: number;
      }
      function buildSelector(el: Element): string {
        const tag = el.tagName.toLowerCase();
        const id = (el as HTMLElement).id ? `#${(el as HTMLElement).id}` : '';
        const cls = el.classList[0] ? `.${el.classList[0]}` : '';
        return `${tag}${id}${cls}`;
      }
      const selector =
        'button, a, label, h1, h2, h3, h4, h5, h6, li, td, th, span, div.btn, .btn, .button, [role="button"], [role="tab"], [role="menuitem"], input[type="button"], input[type="submit"]';
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector));
      const hits: Hit[] = [];
      for (const el of candidates) {
        if (hits.length >= limit) break;
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        // Only elements that actually render text (skip wrappers with child elements but no own text).
        if (el.childElementCount > 0) {
          const ownText = Array.from(el.childNodes)
            .filter((n) => n.nodeType === Node.TEXT_NODE)
            .map((n) => (n.nodeValue ?? '').trim())
            .join('')
            .trim();
          if (!ownText) continue;
        }
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        // Only fixed/constrained-width containers can meaningfully "overflow".
        const isClipping =
          cs.overflow === 'hidden' ||
          cs.overflowX === 'hidden' ||
          cs.overflow === 'clip' ||
          cs.overflowX === 'clip' ||
          cs.textOverflow === 'ellipsis' ||
          cs.whiteSpace === 'nowrap';
        if (el.scrollWidth > el.clientWidth + 1 && isClipping) {
          hits.push({
            locale: localeArg,
            target: buildSelector(el),
            tag: el.tagName.toLowerCase(),
            text: text.slice(0, 200),
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
          });
        }
      }
      return hits;
    },
    { localeArg: locale, limit: maxHits },
  );
}
