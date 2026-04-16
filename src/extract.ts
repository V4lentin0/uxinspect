/**
 * P3 #28 — NL extract with Zod schema.
 *
 * Extracts structured data from a page using heuristic regex patterns
 * for common types, with optional LLM fallback for complex schemas.
 */

import type { Page } from 'playwright';

// ─── Pattern extractors ──────────────────────────────────────────

const PATTERNS: Record<string, RegExp> = {
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  phone: /\+?[\d\s\-().]{7,20}/g,
  price: /[$€£¥₹]\s?\d[\d,]*\.?\d{0,2}|\d[\d,]*\.?\d{0,2}\s?(?:USD|EUR|GBP|JPY|INR)/gi,
  date: /\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\w+ \d{1,2},?\s?\d{4}/g,
  url: /https?:\/\/[^\s"'<>]+/g,
  number: /\b\d[\d,]*\.?\d*\b/g,
  boolean: /\b(true|false|yes|no|enabled|disabled|on|off)\b/gi,
};

interface ExtractOptions {
  /** Optional LLM hook for complex schemas. */
  llmHook?: (text: string, instruction: string) => Promise<Record<string, unknown>>;
}

interface ExtractResult<T = unknown> {
  data: T;
  confidence: Record<string, number>;
}

/**
 * Extract structured data from visible page text, validated against a
 * Zod-compatible schema.
 */
export async function extractFromPage<T>(
  page: Page,
  instruction: string,
  schema: { parse: (data: unknown) => T; shape?: Record<string, unknown> },
  opts: ExtractOptions = {},
): Promise<ExtractResult<T>> {
  const text = await page.evaluate(() =>
    (document.body?.innerText ?? '').slice(0, 20_000),
  );

  const fields = schema.shape ? Object.keys(schema.shape) : [];
  const extracted: Record<string, unknown> = {};
  const confidence: Record<string, number> = {};

  for (const field of fields) {
    const { value, conf } = extractField(field, text, instruction);
    if (value !== undefined) {
      extracted[field] = value;
      confidence[field] = conf;
    }
  }

  // LLM fallback for unfilled fields
  if (opts.llmHook) {
    const missing = fields.filter((f) => extracted[f] === undefined);
    if (missing.length > 0) {
      try {
        const llmResult = await opts.llmHook(text, instruction);
        for (const f of missing) {
          if (llmResult[f] !== undefined) {
            extracted[f] = llmResult[f];
            confidence[f] = 0.6;
          }
        }
      } catch {
        // LLM unavailable — leave fields unfilled
      }
    }
  }

  const data = schema.parse(extracted);
  return { data, confidence };
}

function extractField(
  field: string,
  text: string,
  _instruction: string,
): { value: unknown; conf: number } {
  const fieldLower = field.toLowerCase();

  // Infer pattern from field name
  if (fieldLower.includes('email') || fieldLower.includes('mail')) {
    return matchPattern('email', text);
  }
  if (fieldLower.includes('phone') || fieldLower.includes('tel') || fieldLower.includes('mobile')) {
    return matchPattern('phone', text);
  }
  if (fieldLower.includes('price') || fieldLower.includes('cost') || fieldLower.includes('amount') || fieldLower.includes('total')) {
    return matchPattern('price', text);
  }
  if (fieldLower.includes('date') || fieldLower.includes('time') || fieldLower === 'at' || fieldLower === 'when') {
    return matchPattern('date', text);
  }
  if (fieldLower.includes('url') || fieldLower.includes('link') || fieldLower.includes('href')) {
    return matchPattern('url', text);
  }
  if (fieldLower.includes('count') || fieldLower.includes('quantity') || fieldLower.includes('num') || fieldLower === 'id') {
    return matchPattern('number', text);
  }
  if (fieldLower.includes('enabled') || fieldLower.includes('active') || fieldLower.includes('is_') || fieldLower.startsWith('has')) {
    return matchPattern('boolean', text);
  }

  // Default: try number then give up
  return { value: undefined, conf: 0 };
}

function matchPattern(
  patternKey: string,
  text: string,
): { value: unknown; conf: number } {
  const re = PATTERNS[patternKey];
  if (!re) return { value: undefined, conf: 0 };
  const matches = text.match(new RegExp(re.source, re.flags));
  if (!matches || matches.length === 0) return { value: undefined, conf: 0 };

  const raw = matches[0].trim();

  if (patternKey === 'boolean') {
    const v = raw.toLowerCase();
    return { value: ['true', 'yes', 'enabled', 'on'].includes(v), conf: 0.9 };
  }
  if (patternKey === 'number') {
    const n = parseFloat(raw.replace(/,/g, ''));
    return { value: isNaN(n) ? undefined : n, conf: 0.8 };
  }
  if (patternKey === 'price') {
    const n = parseFloat(raw.replace(/[^0-9.]/g, ''));
    return { value: isNaN(n) ? raw : n, conf: 0.85 };
  }

  return { value: raw, conf: 0.9 };
}
