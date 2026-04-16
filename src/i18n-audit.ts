import type { Page } from 'playwright';

/**
 * Per-locale i18n / RTL / overflow audit (P4 #36).
 *
 * For each configured locale the runner navigates to `<url>?<langQueryParam>=<locale>`
 * (or sets a cookie) and inspects the rendered page for:
 *   1. Un-translated keys leaking to UI (e.g. `WELCOME_TITLE`, `profile.name`, `{{var}}`).
 *   2. Missing `dir="rtl"` on `<html>` for RTL locales (ar/he/fa/ur/yi).
 *   3. Text that overflows its container on interactive / label elements.
 *   4. "Tofu" characters — chars the active font cannot render (glyph width 0).
 *
 * Everything runs in a real Playwright page (no mock locales).
 */

export type I18nIssueKind =
  | 'missing-translation-key'
  | 'unrendered-placeholder'
  | 'rtl-dir-missing'
  | 'rtl-dir-wrong'
  | 'ltr-layout-in-rtl'
  | 'text-overflow'
  | 'font-coverage-gap'
  | 'navigation-failed';

export type I18nIssueSeverity = 'info' | 'warn' | 'error';

export interface I18nIssue {
  kind: I18nIssueKind;
  severity: I18nIssueSeverity;
  locale: string;
  detail: string;
  target?: string;
  snippet?: string;
}

export interface I18nLocaleSummary {
  locale: string;
  url: string;
  direction: 'ltr' | 'rtl' | 'auto' | null;
  expectedRtl: boolean;
  htmlLang: string | null;
  keysDetected: number;
  placeholdersDetected: number;
  overflowsDetected: number;
  tofuDetected: number;
  visited: boolean;
}

export interface I18nResult {
  page: string;
  locales: string[];
  summaries: I18nLocaleSummary[];
  issues: I18nIssue[];
  passed: boolean;
}

export interface I18nConfig {
  /** Locales to probe. Defaults to ['en', 'ar', 'de', 'ja', 'zh']. */
  locales?: string[];
  /** Query-string parameter to inject per locale. Defaults to `lang`. */
  langQueryParam?: string;
  /** Cookie name used to pin the locale (instead of / in addition to the query param). */
  cookieName?: string;
  /**
   * Regex to detect un-translated keys leaking to UI.
   * Default matches `ALL_CAPS_UNDERSCORE` and dotted `snake.case.key` patterns.
   */
  i18nKeyPattern?: RegExp;
  /** Max visible-text characters to scan per locale (safety bound). Default 20000. */
  maxTextChars?: number;
  /** Max overflow findings per locale. Default 40. */
  maxOverflows?: number;
  /**
   * Selector list scanned for overflow. Defaults to common label / nav / button primitives.
   */
  overflowSelectors?: string[];
  /** Max navigation wait per locale in ms. Default 15000. */
  navigationTimeoutMs?: number;
}

interface ResolvedConfig {
  locales: string[];
  langQueryParam: string;
  cookieName?: string;
  i18nKeyPattern: RegExp;
  isDefaultKeyPattern: boolean;
  maxTextChars: number;
  maxOverflows: number;
  overflowSelectors: string[];
  navigationTimeoutMs: number;
}

const DEFAULT_LOCALES = ['en', 'ar', 'de', 'ja', 'zh'];
const RTL_LOCALES = new Set(['ar', 'he', 'fa', 'ur', 'yi']);
const DEFAULT_KEY_RE = /(?:\b[A-Z][A-Z0-9_]{3,}[A-Z0-9](?:\.[A-Z0-9_]+)*\b|\b[a-z][a-z0-9_]*(?:\.[a-z0-9_]+){1,}\b)/;
const DEFAULT_OVERFLOW_SELECTORS = [
  'button',
  'a[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="link"]',
  'nav a',
  'nav button',
  'label',
  'th',
  '.btn',
  '.button',
  '.nav-item',
  '.tab',
  '.menu-item',
];

function resolveConfig(opts?: I18nConfig): ResolvedConfig {
  const userPattern = opts?.i18nKeyPattern;
  return {
    locales: opts?.locales?.length ? opts.locales : DEFAULT_LOCALES,
    langQueryParam: opts?.langQueryParam ?? 'lang',
    cookieName: opts?.cookieName,
    i18nKeyPattern: userPattern ?? DEFAULT_KEY_RE,
    isDefaultKeyPattern: userPattern === undefined,
    maxTextChars: opts?.maxTextChars ?? 20000,
    maxOverflows: opts?.maxOverflows ?? 40,
    overflowSelectors: opts?.overflowSelectors?.length
      ? opts.overflowSelectors
      : DEFAULT_OVERFLOW_SELECTORS,
    navigationTimeoutMs: opts?.navigationTimeoutMs ?? 15000,
  };
}

function primaryLocale(locale: string): string {
  return locale.toLowerCase().split(/[-_]/)[0] ?? '';
}

function isRtlLocale(locale: string): boolean {
  return RTL_LOCALES.has(primaryLocale(locale));
}

function buildLocaleUrl(baseUrl: string, param: string, locale: string): string {
  try {
    const u = new URL(baseUrl);
    u.searchParams.set(param, locale);
    return u.toString();
  } catch {
    // Fallback for non-URL strings (e.g. `about:blank` in tests).
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}${encodeURIComponent(param)}=${encodeURIComponent(locale)}`;
  }
}

interface DomScan {
  htmlLang: string | null;
  dir: string | null;
  bodyDir: string | null;
  visibleText: string;
  overflows: Array<{ selector: string; text: string; scrollWidth: number; clientWidth: number }>;
  tofus: Array<{ selector: string; snippet: string; char: string }>;
  ltrLayoutInRtl: Array<{ selector: string; detail: string }>;
}

async function scanDom(page: Page, expectedRtl: boolean, cfg: ResolvedConfig): Promise<DomScan> {
  return await page.evaluate(
    (args): DomScan => {
      const selectors: string[] = args.selectors;
      const maxChars: number = args.maxChars;
      const maxOverflows: number = args.maxOverflows;
      const expectRtl: boolean = args.expectRtl;

      function buildSelector(el: Element): string {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${CSS.escape(el.id)}` : '';
        const first = el.classList[0] ? `.${CSS.escape(el.classList[0])}` : '';
        return `${tag}${id}${first}`;
      }

      function trunc(s: string, n: number): string {
        const t = (s || '').replace(/\s+/g, ' ').trim();
        return t.length > n ? t.slice(0, n) + '...' : t;
      }

      // Walk visible text nodes.
      const texts: string[] = [];
      let total = 0;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Node | null = walker.nextNode();
      while (node && total < maxChars) {
        const parent = node.parentElement;
        if (parent) {
          const tag = parent.tagName;
          if (tag !== 'SCRIPT' && tag !== 'STYLE' && tag !== 'NOSCRIPT') {
            const cs = window.getComputedStyle(parent);
            if (cs.display !== 'none' && cs.visibility !== 'hidden') {
              const raw = (node.nodeValue || '').trim();
              if (raw.length > 0) {
                texts.push(raw);
                total += raw.length;
              }
            }
          }
        }
        node = walker.nextNode();
      }
      const visibleText = texts.join('\n').slice(0, maxChars);

      // Overflow scan — elements whose text content overflows their own box.
      const overflows: Array<{ selector: string; text: string; scrollWidth: number; clientWidth: number }> = [];
      const seen = new Set<Element>();
      for (const sel of selectors) {
        let nodes: Element[];
        try {
          nodes = Array.from(document.querySelectorAll(sel));
        } catch {
          continue;
        }
        for (const el of nodes) {
          if (seen.has(el)) continue;
          seen.add(el);
          if (overflows.length >= maxOverflows) break;
          const cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const sw = (el as HTMLElement).scrollWidth;
          const cw = (el as HTMLElement).clientWidth;
          if (cw > 0 && sw > cw + 1) {
            overflows.push({
              selector: buildSelector(el),
              text: trunc(el.textContent || '', 80),
              scrollWidth: sw,
              clientWidth: cw,
            });
          }
        }
        if (overflows.length >= maxOverflows) break;
      }

      // Tofu detection: render a single char at a time in a hidden probe span
      // and flag any char whose rendered width is 0 in a context where other
      // chars render. This catches font-coverage gaps without false positives
      // from whitespace.
      const tofus: Array<{ selector: string; snippet: string; char: string }> = [];
      const probe = document.createElement('span');
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      probe.style.whiteSpace = 'pre';
      probe.style.fontSize = '20px';
      probe.style.left = '-9999px';
      probe.style.top = '-9999px';
      document.body.appendChild(probe);

      // Reference width: "a" should render in any font stack.
      probe.textContent = 'a';
      const refWidth = probe.getBoundingClientRect().width;

      const tofuSamples = new Set<string>();
      for (const chunk of texts) {
        for (const ch of chunk) {
          if (tofuSamples.has(ch)) continue;
          if (/\s/.test(ch) || ch.charCodeAt(0) < 32) continue;
          if (ch.charCodeAt(0) < 128) continue; // skip ASCII (almost always covered)
          tofuSamples.add(ch);
          probe.textContent = ch;
          const w = probe.getBoundingClientRect().width;
          if (refWidth > 0 && w === 0) {
            tofus.push({
              selector: 'document',
              snippet: trunc(chunk, 40),
              char: ch,
            });
            if (tofus.length >= 20) break;
          }
        }
        if (tofus.length >= 20) break;
      }
      probe.remove();

      // LTR-in-RTL layout smells: when we expect RTL, look at primitives whose
      // computed writing direction is still ltr, or whose flex-direction is
      // hard-coded row-reverse/row without reflecting the document dir.
      const ltrLayoutInRtl: Array<{ selector: string; detail: string }> = [];
      if (expectRtl) {
        const candidates = Array.from(document.querySelectorAll('header, nav, main, footer, [role="navigation"], [role="toolbar"]')).slice(0, 40);
        for (const el of candidates) {
          const cs = window.getComputedStyle(el);
          if (cs.direction === 'ltr') {
            ltrLayoutInRtl.push({
              selector: buildSelector(el),
              detail: `computed direction is ltr in an RTL locale`,
            });
            if (ltrLayoutInRtl.length >= 10) break;
          }
        }
      }

      const htmlEl = document.documentElement;
      const body = document.body;
      return {
        htmlLang: htmlEl.getAttribute('lang'),
        dir: htmlEl.getAttribute('dir'),
        bodyDir: body ? body.getAttribute('dir') : null,
        visibleText,
        overflows,
        tofus,
        ltrLayoutInRtl,
      };
    },
    {
      selectors: cfg.overflowSelectors,
      maxChars: cfg.maxTextChars,
      maxOverflows: cfg.maxOverflows,
      expectRtl: expectedRtl,
    },
  );
}

function findUnrenderedPlaceholders(text: string): string[] {
  const out: string[] = [];
  const mustache = text.match(/\{\{\s*[A-Za-z_][A-Za-z0-9_.]*\s*\}\}/g);
  if (mustache) out.push(...mustache);
  const percent = text.match(/%\{[A-Za-z_][A-Za-z0-9_.]*\}/g);
  if (percent) out.push(...percent);
  const dollar = text.match(/\$\{[A-Za-z_][A-Za-z0-9_.]*\}/g);
  if (dollar) out.push(...dollar);
  return Array.from(new Set(out)).slice(0, 20);
}

function findUntranslatedKeys(text: string, pattern: RegExp, isDefault: boolean): string[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
  const global = new RegExp(pattern.source, flags);
  const out = new Set<string>();
  for (const m of text.matchAll(global)) {
    const hit = m[0];
    if (isDefault) {
      // Only apply noise filters to the default regex; a user-supplied regex
      // is trusted as-is.
      if (/^(https?|ftp|mailto|tel)$/i.test(hit)) continue;
      if (/^[A-Z]{1,2}$/.test(hit)) continue;
      if (!hit.includes('_') && !hit.includes('.')) continue;
      if (/^\d/.test(hit)) continue;
    }
    out.add(hit);
    if (out.size >= 30) break;
  }
  return Array.from(out);
}

async function navigateLocale(
  page: Page,
  url: string,
  locale: string,
  cfg: ResolvedConfig,
): Promise<{ ok: true; finalUrl: string } | { ok: false; error: string }> {
  try {
    if (cfg.cookieName) {
      try {
        const u = new URL(url);
        await page.context().addCookies([
          {
            name: cfg.cookieName,
            value: locale,
            domain: u.hostname,
            path: '/',
          },
        ]);
      } catch {
        // ignore — cookie setting is best-effort
      }
    }
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: cfg.navigationTimeoutMs,
    });
    return { ok: true, finalUrl: page.url() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Audit a page across several locales for i18n / RTL / overflow regressions. */
export async function runI18nAudit(page: Page, opts?: I18nConfig): Promise<I18nResult> {
  const cfg = resolveConfig(opts);
  const baseUrl = page.url() || 'about:blank';
  const issues: I18nIssue[] = [];
  const summaries: I18nLocaleSummary[] = [];

  for (const locale of cfg.locales) {
    const expectedRtl = isRtlLocale(locale);
    const target = buildLocaleUrl(baseUrl, cfg.langQueryParam, locale);

    const nav = await navigateLocale(page, target, locale, cfg);
    if (!nav.ok) {
      issues.push({
        kind: 'navigation-failed',
        severity: 'error',
        locale,
        detail: `could not load ${target}: ${nav.error}`,
      });
      summaries.push({
        locale,
        url: target,
        direction: null,
        expectedRtl,
        htmlLang: null,
        keysDetected: 0,
        placeholdersDetected: 0,
        overflowsDetected: 0,
        tofuDetected: 0,
        visited: false,
      });
      continue;
    }

    let scan: DomScan;
    try {
      scan = await scanDom(page, expectedRtl, cfg);
    } catch (err) {
      issues.push({
        kind: 'navigation-failed',
        severity: 'error',
        locale,
        detail: `dom scan failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const keys = findUntranslatedKeys(scan.visibleText, cfg.i18nKeyPattern, cfg.isDefaultKeyPattern);
    for (const k of keys) {
      issues.push({
        kind: 'missing-translation-key',
        severity: 'warn',
        locale,
        detail: `un-translated key "${k}" visible in rendered UI`,
        snippet: k,
      });
    }

    const placeholders = findUnrenderedPlaceholders(scan.visibleText);
    for (const p of placeholders) {
      issues.push({
        kind: 'unrendered-placeholder',
        severity: 'error',
        locale,
        detail: `unrendered placeholder "${p}" leaked to UI`,
        snippet: p,
      });
    }

    const effectiveDir = (scan.dir || scan.bodyDir || '').toLowerCase();
    if (expectedRtl) {
      if (!effectiveDir) {
        issues.push({
          kind: 'rtl-dir-missing',
          severity: 'error',
          locale,
          detail: `RTL locale "${locale}" but html has no dir attribute`,
        });
      } else if (effectiveDir !== 'rtl') {
        issues.push({
          kind: 'rtl-dir-wrong',
          severity: 'error',
          locale,
          detail: `RTL locale "${locale}" but html[dir]="${effectiveDir}"`,
        });
      }
      for (const el of scan.ltrLayoutInRtl) {
        issues.push({
          kind: 'ltr-layout-in-rtl',
          severity: 'warn',
          locale,
          detail: el.detail,
          target: el.selector,
        });
      }
    }

    for (const o of scan.overflows) {
      issues.push({
        kind: 'text-overflow',
        severity: 'warn',
        locale,
        detail: `text overflows container (scrollWidth=${o.scrollWidth} > clientWidth=${o.clientWidth})`,
        target: o.selector,
        snippet: o.text,
      });
    }

    for (const t of scan.tofus) {
      issues.push({
        kind: 'font-coverage-gap',
        severity: 'warn',
        locale,
        detail: `font stack cannot render U+${t.char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
        target: t.selector,
        snippet: t.snippet,
      });
    }

    const dirNorm: 'ltr' | 'rtl' | 'auto' | null =
      effectiveDir === 'rtl' || effectiveDir === 'ltr' || effectiveDir === 'auto'
        ? (effectiveDir as 'ltr' | 'rtl' | 'auto')
        : null;

    summaries.push({
      locale,
      url: nav.finalUrl,
      direction: dirNorm,
      expectedRtl,
      htmlLang: scan.htmlLang,
      keysDetected: keys.length,
      placeholdersDetected: placeholders.length,
      overflowsDetected: scan.overflows.length,
      tofuDetected: scan.tofus.length,
      visited: true,
    });
  }

  return {
    page: baseUrl,
    locales: cfg.locales,
    summaries,
    issues,
    passed: issues.every((i) => i.severity !== 'error'),
  };
}

export const DEFAULT_I18N_LOCALES = DEFAULT_LOCALES;
export const DEFAULT_I18N_OVERFLOW_SELECTORS = DEFAULT_OVERFLOW_SELECTORS;
