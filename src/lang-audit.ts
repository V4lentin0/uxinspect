import type { Page } from 'playwright';

export type LangIssueType =
  | 'missing-html-lang'
  | 'invalid-html-lang'
  | 'missing-dir-rtl'
  | 'lang-mismatch-with-content'
  | 'empty-lang-attr';

export interface LangIssue {
  type: LangIssueType;
  detail: string;
  target?: string;
}

export interface LangSwitch {
  target: string;
  lang: string;
  text: string;
}

export interface LangAuditResult {
  page: string;
  htmlLang?: string;
  htmlLangValid: boolean;
  dir?: string;
  xmlLang?: string;
  langSwitches: LangSwitch[];
  issues: LangIssue[];
  passed: boolean;
}

export async function auditLang(page: Page): Promise<LangAuditResult> {
  const url = page.url();

  const scan = await page.evaluate(() => {
    type IssueType =
      | 'missing-html-lang'
      | 'invalid-html-lang'
      | 'missing-dir-rtl'
      | 'lang-mismatch-with-content'
      | 'empty-lang-attr';

    interface Issue {
      type: IssueType;
      detail: string;
      target?: string;
    }

    interface Switch {
      target: string;
      lang: string;
      text: string;
    }

    const BCP47 = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-\d{3})?(-[a-zA-Z0-9]{5,8})?$/i;
    const RTL_LANGS = new Set(['ar', 'he', 'fa', 'ur', 'yi']);

    function buildSelector(el: Element): string {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${CSS.escape(el.id)}` : '';
      const first = el.classList[0] ? `.${CSS.escape(el.classList[0])}` : '';
      return `${tag}${id}${first}`;
    }

    function truncate(s: string, n: number): string {
      const trimmed = s.replace(/\s+/g, ' ').trim();
      return trimmed.length > n ? trimmed.slice(0, n) + '...' : trimmed;
    }

    function primaryOf(lang: string): string {
      return lang.toLowerCase().split('-')[0] ?? '';
    }

    const htmlEl = document.documentElement;
    const rawHtmlLang = htmlEl.getAttribute('lang');
    const htmlLang = rawHtmlLang === null ? undefined : rawHtmlLang;
    const dirAttr = htmlEl.getAttribute('dir');
    const dir = dirAttr === null ? undefined : dirAttr;
    const xmlLangAttr = htmlEl.getAttribute('xml:lang');
    const xmlLang = xmlLangAttr === null ? undefined : xmlLangAttr;

    const issues: Issue[] = [];
    let htmlLangValid = false;

    if (htmlLang === undefined) {
      issues.push({
        type: 'missing-html-lang',
        detail: 'html element has no lang attribute',
      });
    } else if (htmlLang.trim() === '') {
      issues.push({
        type: 'invalid-html-lang',
        detail: 'html[lang] is empty',
      });
    } else if (!BCP47.test(htmlLang.trim())) {
      issues.push({
        type: 'invalid-html-lang',
        detail: `html[lang]="${htmlLang}" is not a valid BCP 47 tag`,
      });
    } else {
      htmlLangValid = true;
    }

    const rootPrimary = htmlLang ? primaryOf(htmlLang) : '';
    if (htmlLangValid && RTL_LANGS.has(rootPrimary) && dir !== 'rtl') {
      issues.push({
        type: 'missing-dir-rtl',
        detail: `primary language "${rootPrimary}" is RTL but html[dir] is not "rtl"`,
      });
    }

    const langSwitches: Switch[] = [];
    const descendants = document.querySelectorAll('[lang]');
    let collected = 0;
    for (const el of Array.from(descendants)) {
      if (el === htmlEl) continue;
      const langRaw = el.getAttribute('lang');
      if (langRaw === null) continue;
      const target = buildSelector(el);
      if (langRaw === '') {
        issues.push({
          type: 'empty-lang-attr',
          detail: 'element has empty lang attribute',
          target,
        });
        continue;
      }
      if (collected < 50) {
        const text = truncate(el.textContent ?? '', 80);
        langSwitches.push({ target, lang: langRaw, text });
        collected++;

        const primary = primaryOf(langRaw);
        const rawText = (el.textContent ?? '').replace(/\s+/g, '');
        if (primary === 'en' && rawText.length > 0) {
          let nonAscii = 0;
          for (const ch of rawText) {
            if (ch.charCodeAt(0) > 127) nonAscii++;
          }
          if (nonAscii / rawText.length > 0.5) {
            issues.push({
              type: 'lang-mismatch-with-content',
              detail: `lang="en" but text is >50% non-ASCII`,
              target,
            });
          }
        } else if (primary && primary !== 'en' && rawText.length > 0) {
          let ascii = 0;
          for (const ch of rawText) {
            if (ch.charCodeAt(0) <= 127) ascii++;
          }
          if (ascii === rawText.length && rawText.length >= 8) {
            const nonLatinScripts = new Set([
              'ar', 'he', 'fa', 'ur', 'yi',
              'zh', 'ja', 'ko',
              'ru', 'uk', 'bg', 'sr', 'mk', 'be',
              'el',
              'hi', 'bn', 'ta', 'te', 'kn', 'ml', 'gu', 'pa', 'si',
              'th', 'lo', 'km', 'my',
              'ka', 'hy', 'am',
            ]);
            if (nonLatinScripts.has(primary)) {
              issues.push({
                type: 'lang-mismatch-with-content',
                detail: `lang="${langRaw}" but text is 100% ASCII`,
                target,
              });
            }
          }
        }
      }
    }

    return {
      htmlLang,
      htmlLangValid,
      dir,
      xmlLang,
      langSwitches,
      issues,
    };
  });

  return {
    page: url,
    htmlLang: scan.htmlLang,
    htmlLangValid: scan.htmlLangValid,
    dir: scan.dir,
    xmlLang: scan.xmlLang,
    langSwitches: scan.langSwitches,
    issues: scan.issues,
    passed: scan.issues.length === 0,
  };
}
