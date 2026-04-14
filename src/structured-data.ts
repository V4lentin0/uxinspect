import type { Page } from 'playwright';

export interface StructuredDataIssue {
  level: 'error' | 'warn';
  type:
    | 'invalid-json'
    | 'missing-type'
    | 'missing-context'
    | 'hreflang-invalid-code'
    | 'hreflang-missing-return'
    | 'hreflang-non-200'
    | 'missing-required-property'
    | 'duplicate-type';
  message: string;
  snippet?: string;
}

export interface StructuredDataItem {
  format: 'json-ld' | 'microdata';
  type: string;
  raw: unknown;
}

export interface StructuredDataResult {
  page: string;
  items: StructuredDataItem[];
  hreflangTags: { lang: string; href: string; valid: boolean }[];
  issues: StructuredDataIssue[];
  passed: boolean;
}

const REQUIRED_PROPS: Record<string, string[]> = {
  Article: ['headline', 'author', 'datePublished'],
  NewsArticle: ['headline', 'author', 'datePublished'],
  BlogPosting: ['headline', 'author', 'datePublished'],
  Product: ['name', 'image', 'offers'],
  Organization: ['name', 'url'],
  Event: ['name', 'startDate', 'location'],
  Recipe: ['name', 'recipeIngredient', 'recipeInstructions'],
  WebSite: ['name', 'url'],
};

const DUPLICATE_WARN_TYPES = new Set(['Product', 'Article', 'NewsArticle']);

const HREFLANG_RE = /^(x-default|[a-z]{2}(-[A-Z]{2})?)$/;

function processObject(
  obj: Record<string, unknown>,
  items: StructuredDataItem[],
  issues: StructuredDataIssue[],
): void {
  if (!('@context' in obj)) {
    issues.push({ level: 'error', type: 'missing-context', message: 'JSON-LD object missing @context' });
  }
  if (!('@type' in obj)) {
    issues.push({ level: 'error', type: 'missing-type', message: 'JSON-LD object missing @type' });
    items.push({ format: 'json-ld', type: 'Unknown', raw: obj });
    return;
  }

  const type = String(obj['@type']);
  items.push({ format: 'json-ld', type, raw: obj });

  const required = REQUIRED_PROPS[type];
  if (required) {
    for (const prop of required) {
      if (!(prop in obj) || obj[prop] === null || obj[prop] === undefined) {
        issues.push({
          level: 'error',
          type: 'missing-required-property',
          message: `${type} missing required property: ${prop}`,
        });
      }
    }
  }

  if (type === 'BreadcrumbList') {
    const list = obj['itemListElement'];
    if (!Array.isArray(list) || list.length === 0) {
      issues.push({
        level: 'error',
        type: 'missing-required-property',
        message: 'BreadcrumbList.itemListElement must be a non-empty array',
      });
    }
  }
}

function processPayload(
  payload: unknown,
  items: StructuredDataItem[],
  issues: StructuredDataIssue[],
): void {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (item && typeof item === 'object') {
        processObject(item as Record<string, unknown>, items, issues);
      }
    }
    return;
  }

  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj['@graph'])) {
      const ctx = obj['@context'];
      for (const node of obj['@graph'] as unknown[]) {
        if (node && typeof node === 'object') {
          const nodeObj = node as Record<string, unknown>;
          const expanded = ctx && !('@context' in nodeObj)
            ? { '@context': ctx, ...nodeObj }
            : nodeObj;
          processObject(expanded, items, issues);
        }
      }
    } else {
      processObject(obj, items, issues);
    }
  }
}

export async function checkStructuredData(page: Page): Promise<StructuredDataResult> {
  const url = page.url();
  const items: StructuredDataItem[] = [];
  const issues: StructuredDataIssue[] = [];

  const scripts: string[] = await page.$$eval(
    'script[type="application/ld+json"]',
    (els) => els.map((s) => (s as HTMLScriptElement).textContent || ''),
  );

  for (const text of scripts) {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      issues.push({
        level: 'error',
        type: 'invalid-json',
        message: 'Failed to parse JSON-LD script',
        snippet: text.trim().slice(0, 120),
      });
      continue;
    }
    processPayload(payload, items, issues);
  }

  const microdataItems = await page.$$eval(
    '[itemscope][itemtype]',
    (els) => els.map((e) => ({ itemtype: e.getAttribute('itemtype') || '' })),
  );
  for (const { itemtype } of microdataItems) {
    const type = itemtype.split('/').pop() || itemtype;
    items.push({ format: 'microdata', type, raw: {} });
  }

  const typeCounts = new Map<string, number>();
  for (const item of items) {
    typeCounts.set(item.type, (typeCounts.get(item.type) ?? 0) + 1);
  }
  for (const [type, count] of typeCounts) {
    if (count > 1 && DUPLICATE_WARN_TYPES.has(type)) {
      issues.push({
        level: 'warn',
        type: 'duplicate-type',
        message: `Duplicate structured data type: ${type} (${count} instances)`,
      });
    }
  }

  const rawTags = await page.$$eval(
    'link[rel="alternate"][hreflang]',
    (els) =>
      els.map((l) => ({
        lang: l.getAttribute('hreflang') || '',
        href: l.getAttribute('href') || '',
      })),
  );

  const hreflangTags: StructuredDataResult['hreflangTags'] = [];

  for (const tag of rawTags) {
    const valid = HREFLANG_RE.test(tag.lang);
    hreflangTags.push({ ...tag, valid });
    if (!valid) {
      issues.push({
        level: 'error',
        type: 'hreflang-invalid-code',
        message: `Invalid hreflang code: "${tag.lang}"`,
        snippet: tag.href,
      });
    }
  }

  if (hreflangTags.length > 0) {
    let hasReturn = false;
    try {
      const currentUrl = new URL(url);
      const currentCanonical = currentUrl.origin + currentUrl.pathname;
      for (const tag of hreflangTags) {
        try {
          const tagUrl = new URL(tag.href, url);
          if (
            tagUrl.href === url ||
            tagUrl.origin + tagUrl.pathname === currentCanonical
          ) {
            hasReturn = true;
            break;
          }
        } catch {
          // malformed href — skip
        }
      }
    } catch {
      // invalid page URL — skip return check
    }
    if (!hasReturn) {
      issues.push({
        level: 'warn',
        type: 'hreflang-missing-return',
        message: 'No hreflang tag points back to the current page URL',
      });
    }
  }

  const passed = !issues.some((i) => i.level === 'error');

  return { page: url, items, hreflangTags, issues, passed };
}
