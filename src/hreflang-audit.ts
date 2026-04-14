import type { Page } from 'playwright';

export interface HreflangEntry {
  lang: string;
  href: string;
  source: 'link' | 'http-header' | 'sitemap';
}

export interface HreflangIssue {
  kind:
    | 'missing-x-default'
    | 'invalid-lang-code'
    | 'non-canonical-url'
    | 'non-absolute-url'
    | 'self-reference-missing'
    | 'reciprocal-missing'
    | 'duplicate-lang'
    | 'wrong-region-format'
    | 'unknown-iso-code';
  lang?: string;
  href?: string;
  detail: string;
}

export interface HreflangAuditResult {
  page: string;
  entries: HreflangEntry[];
  issues: HreflangIssue[];
  hasXDefault: boolean;
  reciprocalChecked: boolean;
  passed: boolean;
}

export interface HreflangOptions {
  followUrls?: boolean;
  maxFollows?: number;
}

const LANG_CODE_RE = /^(x-default|[a-z]{2,3}(-[A-Z]{2})?)$/;
const LANG_CODE_CI_RE = /^(x-default|[a-z]{2,3}(-[a-zA-Z]{2})?)$/i;

const KNOWN_ISO_639_1 = new Set([
  'en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'ru', 'uk',
  'ja', 'zh', 'ko', 'ar', 'he', 'tr', 'hi', 'bn', 'id', 'vi',
  'th', 'sv', 'no', 'da', 'fi', 'cs', 'el', 'hu', 'ro', 'bg',
  'sk', 'hr', 'sr', 'sl', 'lt', 'lv', 'et', 'ms', 'fa', 'ur',
]);

const KNOWN_ISO_3166 = new Set([
  'US', 'GB', 'CA', 'AU', 'NZ', 'IE', 'IN', 'ZA',
  'DE', 'AT', 'CH', 'FR', 'BE', 'LU', 'ES', 'MX', 'AR', 'BR',
  'PT', 'IT', 'NL', 'PL', 'RU', 'UA', 'JP', 'CN', 'TW', 'HK',
  'KR', 'SG', 'MY', 'ID', 'TH', 'VN', 'PH', 'TR', 'IL', 'AE',
  'SA', 'EG', 'SE', 'NO', 'DK', 'FI', 'CZ', 'GR', 'HU', 'RO',
]);

interface DomHreflang {
  lang: string;
  href: string;
}

async function readDom(page: Page): Promise<{ links: DomHreflang[]; canonical: string | null }> {
  return await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll('link[rel=alternate][hreflang]'),
    ) as HTMLLinkElement[];
    const links: { lang: string; href: string }[] = [];
    for (const node of nodes) {
      links.push({
        lang: node.getAttribute('hreflang') ?? '',
        href: node.getAttribute('href') ?? '',
      });
    }
    const can = document.querySelector('link[rel=canonical]') as HTMLLinkElement | null;
    return { links, canonical: can?.getAttribute('href') ?? null };
  });
}

function isAbsoluteUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function normalizeUrl(raw: string, base?: string): string {
  try {
    const u = base ? new URL(raw, base) : new URL(raw);
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
    u.hash = '';
    const path = u.pathname.length > 1 && u.pathname.endsWith('/')
      ? u.pathname.slice(0, -1)
      : u.pathname;
    u.pathname = path;
    return u.toString();
  } catch {
    return raw;
  }
}

function validateLang(
  lang: string,
  href: string,
  issues: HreflangIssue[],
): { valid: boolean; base: string } {
  if (!lang) {
    issues.push({
      kind: 'invalid-lang-code',
      lang,
      href,
      detail: 'empty hreflang attribute',
    });
    return { valid: false, base: '' };
  }

  if (!LANG_CODE_CI_RE.test(lang)) {
    issues.push({
      kind: 'invalid-lang-code',
      lang,
      href,
      detail: `hreflang "${lang}" does not match ^(x-default|[a-z]{2,3}(-[A-Z]{2})?)$`,
    });
    return { valid: false, base: '' };
  }

  if (!LANG_CODE_RE.test(lang) && lang !== 'x-default') {
    const parts = lang.split('-');
    if (parts.length === 2) {
      issues.push({
        kind: 'wrong-region-format',
        lang,
        href,
        detail: `region "${parts[1]}" must be uppercase ISO 3166 alpha-2 (e.g. "${parts[0]}-${parts[1].toUpperCase()}")`,
      });
    } else {
      issues.push({
        kind: 'invalid-lang-code',
        lang,
        href,
        detail: `hreflang "${lang}" has invalid casing`,
      });
    }
    return { valid: false, base: '' };
  }

  if (lang === 'x-default') return { valid: true, base: 'x-default' };

  const [base, region] = lang.split('-');
  if (!KNOWN_ISO_639_1.has(base)) {
    issues.push({
      kind: 'unknown-iso-code',
      lang,
      href,
      detail: `language "${base}" is not in the known ISO 639-1 list`,
    });
  }
  if (region && !KNOWN_ISO_3166.has(region)) {
    issues.push({
      kind: 'unknown-iso-code',
      lang,
      href,
      detail: `region "${region}" is not in the known ISO 3166 alpha-2 list`,
    });
  }
  return { valid: true, base };
}

function extractHreflangsFromHtml(html: string): { lang: string; href: string }[] {
  const out: { lang: string; href: string }[] = [];
  const tagRe = /<link\b[^>]*\brel\s*=\s*["']?alternate["']?[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    const tag = match[0];
    const langMatch = /\bhreflang\s*=\s*["']([^"']+)["']/i.exec(tag);
    const hrefMatch = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (langMatch && hrefMatch) {
      out.push({ lang: langMatch[1], href: hrefMatch[1] });
    }
  }
  return out;
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function checkReciprocal(
  originHref: string,
  entries: HreflangEntry[],
  issues: HreflangIssue[],
  maxFollows: number,
): Promise<void> {
  const originNorm = normalizeUrl(originHref);
  const targets = entries.filter((e) => e.lang !== 'x-default').slice(0, maxFollows);
  for (const target of targets) {
    if (!isAbsoluteUrl(target.href)) continue;
    if (normalizeUrl(target.href) === originNorm) continue;
    const html = await fetchHtml(target.href);
    if (html === null) {
      issues.push({
        kind: 'reciprocal-missing',
        lang: target.lang,
        href: target.href,
        detail: `could not fetch "${target.href}" to verify reciprocal hreflang`,
      });
      continue;
    }
    const remote = extractHreflangsFromHtml(html);
    const hasBack = remote.some((r) => {
      try {
        return normalizeUrl(r.href, target.href) === originNorm;
      } catch {
        return false;
      }
    });
    if (!hasBack) {
      issues.push({
        kind: 'reciprocal-missing',
        lang: target.lang,
        href: target.href,
        detail: `target "${target.href}" does not hreflang back to origin "${originHref}"`,
      });
    }
  }
}

export async function auditHreflang(
  page: Page,
  opts?: HreflangOptions,
): Promise<HreflangAuditResult> {
  const followUrls = opts?.followUrls ?? false;
  const maxFollows = opts?.maxFollows ?? 10;
  const pageUrl = page.url();
  const issues: HreflangIssue[] = [];
  const entries: HreflangEntry[] = [];

  const dom = await readDom(page);

  const seenLangs = new Map<string, number>();
  for (const link of dom.links) {
    entries.push({ lang: link.lang, href: link.href, source: 'link' });

    const validation = validateLang(link.lang, link.href, issues);

    if (!link.href) {
      issues.push({
        kind: 'non-absolute-url',
        lang: link.lang,
        href: link.href,
        detail: 'empty href attribute',
      });
    } else if (!isAbsoluteUrl(link.href)) {
      issues.push({
        kind: 'non-absolute-url',
        lang: link.lang,
        href: link.href,
        detail: `href "${link.href}" must be an absolute URL (http:// or https://)`,
      });
    }

    if (validation.valid) {
      const key = link.lang.toLowerCase();
      seenLangs.set(key, (seenLangs.get(key) ?? 0) + 1);
    }
  }

  for (const [lang, count] of seenLangs) {
    if (count > 1) {
      issues.push({
        kind: 'duplicate-lang',
        lang,
        detail: `hreflang "${lang}" appears ${count} times`,
      });
    }
  }

  const hasXDefault = entries.some((e) => e.lang.toLowerCase() === 'x-default');
  const langCount = entries.filter((e) => e.lang.toLowerCase() !== 'x-default').length;
  if (langCount >= 2 && !hasXDefault) {
    issues.push({
      kind: 'missing-x-default',
      detail: `found ${langCount} hreflang entries but no x-default`,
    });
  }

  const canonicalAbs = dom.canonical
    ? (() => { try { return new URL(dom.canonical!, pageUrl).toString(); } catch { return pageUrl; } })()
    : pageUrl;
  const selfNorm = normalizeUrl(canonicalAbs);
  const pageNorm = normalizeUrl(pageUrl);

  const selfListed = entries.some((e) => {
    if (!isAbsoluteUrl(e.href)) return false;
    const n = normalizeUrl(e.href);
    return n === selfNorm || n === pageNorm;
  });

  if (entries.length > 0 && !selfListed) {
    issues.push({
      kind: 'self-reference-missing',
      detail: `current page "${pageUrl}" is not listed among hreflang entries`,
    });
  }

  if (dom.canonical) {
    const canonicalNorm = normalizeUrl(dom.canonical, pageUrl);
    const anyCanonical = entries.some((e) => {
      if (!isAbsoluteUrl(e.href)) return false;
      return normalizeUrl(e.href) === canonicalNorm;
    });
    if (entries.length > 0 && !anyCanonical && canonicalNorm !== pageNorm) {
      issues.push({
        kind: 'non-canonical-url',
        detail: `canonical "${dom.canonical}" does not match any hreflang href`,
      });
    }
  }

  let reciprocalChecked = false;
  if (followUrls && entries.length > 0) {
    reciprocalChecked = true;
    await checkReciprocal(canonicalAbs, entries, issues, maxFollows);
  }

  return {
    page: pageUrl,
    entries,
    issues,
    hasXDefault,
    reciprocalChecked,
    passed: issues.length === 0,
  };
}
