import type { Page } from 'playwright';
import type { ZodTypeAny, z } from 'zod';

export type ExtractSource = 'heuristic' | 'llm';

export interface ExtractResult<T = unknown> {
  data: T;
  source: ExtractSource;
  confidence: number;
}

export interface ExtractOptions {
  /** Raw text override - when provided, skip Page scraping. Useful for testing. */
  text?: string;
  /** Override DOM/HTML used for LLM fallback. */
  html?: string;
  /** Ollama base URL. Defaults to env OLLAMA_URL then http://localhost:11434 (only used if explicitly enabled). */
  ollamaUrl?: string;
  /** Model for Ollama request. Defaults to env OLLAMA_MODEL then llama3. */
  ollamaModel?: string;
  /** Enable Ollama fallback. Disabled by default so builds/tests don't hit network. */
  ollamaEnabled?: boolean;
  /** Optional fetch impl (tests inject mock). */
  fetchImpl?: typeof fetch;
  /** Max chars of page text sent to LLM. */
  maxTextChars?: number;
  /** Abort signal for LLM call. */
  signal?: AbortSignal;
}

const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i;
const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/i;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/;
const MONEY_RE = /(?:[\$£€¥₹]|USD|EUR|GBP|JPY|INR)\s?\d{1,3}(?:[,.\s]\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?\s?(?:USD|EUR|GBP|JPY|INR)/i;
const INT_RE = /-?\d+/;
const FLOAT_RE = /-?\d+(?:\.\d+)?/;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/;

/** Inspect a Zod type and return a lightweight descriptor used by both heuristic and LLM paths. */
export interface FieldDescriptor {
  key: string;
  kind: 'string' | 'number' | 'boolean' | 'date' | 'email' | 'url' | 'phone' | 'money' | 'unknown';
  optional: boolean;
  description?: string;
}

export function describeSchema(schema: ZodTypeAny): FieldDescriptor[] {
  const def: any = (schema as any)?._def;
  if (!def) return [];
  // Unwrap ZodObject
  if (def.typeName === 'ZodObject') {
    const shape: Record<string, ZodTypeAny> = typeof def.shape === 'function' ? def.shape() : def.shape;
    return Object.entries(shape).map(([key, node]) => describeField(key, node));
  }
  // Single-field anonymous
  return [describeField('value', schema)];
}

function describeField(key: string, node: ZodTypeAny): FieldDescriptor {
  let current: any = node;
  let optional = false;
  let description: string | undefined;
  while (current) {
    const d = current._def;
    if (!d) break;
    if (d.description && !description) description = d.description;
    if (d.typeName === 'ZodOptional' || d.typeName === 'ZodNullable' || d.typeName === 'ZodDefault') {
      optional = true;
      current = d.innerType ?? d.schema;
      continue;
    }
    break;
  }
  const typeName: string = current?._def?.typeName ?? '';
  const k = key.toLowerCase();
  let kind: FieldDescriptor['kind'] = 'unknown';
  if (typeName === 'ZodString') {
    if (current._def.checks?.some((c: any) => c.kind === 'email') || k.includes('email')) kind = 'email';
    else if (current._def.checks?.some((c: any) => c.kind === 'url') || k.includes('url') || k.includes('link') || k.includes('website')) kind = 'url';
    else if (k.includes('phone') || k.includes('tel')) kind = 'phone';
    else if (k.includes('price') || k.includes('amount') || k.includes('cost') || k.includes('total')) kind = 'money';
    else if (k.includes('date') || k.includes('time') || k.includes('at')) kind = 'date';
    else kind = 'string';
  } else if (typeName === 'ZodNumber') {
    if (k.includes('price') || k.includes('amount') || k.includes('cost') || k.includes('total')) kind = 'money';
    else kind = 'number';
  } else if (typeName === 'ZodBoolean') {
    kind = 'boolean';
  } else if (typeName === 'ZodDate') {
    kind = 'date';
  }
  return { key, kind, optional, description };
}

/** Attempt to extract a single field from raw text via regex/keyword heuristics. */
export function heuristicExtractField(text: string, field: FieldDescriptor): { value: unknown; confidence: number } | null {
  const lower = text.toLowerCase();
  const keyLower = field.key.toLowerCase();

  // Look for "key: value" style first
  const labeled = new RegExp(`${escapeRegex(keyLower)}\\s*[:=-]\\s*([^\\n\\r]+)`, 'i');
  const labeledMatch = text.match(labeled);
  const labeledValue = labeledMatch?.[1]?.trim();

  const tryRegex = (re: RegExp, scope: string): string | null => {
    const m = scope.match(re);
    return m?.[0] ?? null;
  };

  switch (field.kind) {
    case 'email': {
      const val = tryRegex(EMAIL_RE, labeledValue ?? text);
      if (!val) return null;
      return { value: val, confidence: labeledValue ? 0.95 : 0.85 };
    }
    case 'url': {
      const val = tryRegex(URL_RE, labeledValue ?? text);
      if (!val) return null;
      return { value: val, confidence: labeledValue ? 0.9 : 0.75 };
    }
    case 'phone': {
      const val = tryRegex(PHONE_RE, labeledValue ?? text);
      if (!val) return null;
      return { value: val.trim(), confidence: labeledValue ? 0.9 : 0.7 };
    }
    case 'money': {
      const val = tryRegex(MONEY_RE, labeledValue ?? text);
      if (!val) return null;
      if (field.kind === 'money' && /number/i.test(String(field))) {
        const num = parseFloat(val.replace(/[^0-9.-]/g, ''));
        if (!Number.isNaN(num)) return { value: num, confidence: labeledValue ? 0.9 : 0.75 };
      }
      return { value: val.trim(), confidence: labeledValue ? 0.9 : 0.75 };
    }
    case 'number': {
      const scope = labeledValue ?? text;
      const match = scope.match(FLOAT_RE) ?? scope.match(INT_RE);
      if (!match) return null;
      const num = parseFloat(match[0]);
      if (Number.isNaN(num)) return null;
      return { value: num, confidence: labeledValue ? 0.9 : 0.55 };
    }
    case 'boolean': {
      const scope = labeledValue ?? '';
      if (/^(true|yes|on|1)$/i.test(scope)) return { value: true, confidence: 0.9 };
      if (/^(false|no|off|0)$/i.test(scope)) return { value: false, confidence: 0.9 };
      if (labeledMatch && new RegExp(`\\b${escapeRegex(keyLower)}\\b`, 'i').test(text)) {
        return { value: true, confidence: 0.5 };
      }
      return null;
    }
    case 'date': {
      const val = tryRegex(DATE_RE, labeledValue ?? text);
      if (!val) return null;
      return { value: val, confidence: labeledValue ? 0.9 : 0.7 };
    }
    case 'string': {
      if (labeledValue) {
        const v = labeledValue.split(/[\n\r]/)[0].trim();
        if (v) return { value: v, confidence: 0.8 };
      }
      // Fallback: find key word and nearby capitalized phrase
      const idx = lower.indexOf(keyLower);
      if (idx >= 0) {
        const slice = text.slice(idx + keyLower.length, idx + keyLower.length + 200);
        const m = slice.match(/[:\-=\s]+([A-Z][\w'’\- ]{2,80})/);
        if (m?.[1]) return { value: m[1].trim(), confidence: 0.55 };
      }
      return null;
    }
    case 'unknown':
    default:
      if (labeledValue) return { value: labeledValue, confidence: 0.6 };
      return null;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function scrapeVisibleText(page: Page, maxChars: number): Promise<string> {
  try {
    const text: string = await page.evaluate(() => {
      const body = document.body;
      return body ? (body.innerText || body.textContent || '') : '';
    });
    return (text || '').slice(0, maxChars);
  } catch {
    return '';
  }
}

async function scrapeHtml(page: Page, maxChars: number): Promise<string> {
  try {
    const html: string = await page.content();
    return (html || '').slice(0, maxChars);
  } catch {
    return '';
  }
}

function buildSchemaDescription(descriptors: FieldDescriptor[]): string {
  return descriptors
    .map((d) => `  ${d.key}: ${d.kind}${d.optional ? ' (optional)' : ''}${d.description ? ` — ${d.description}` : ''}`)
    .join('\n');
}

interface OllamaCallArgs {
  url: string;
  model: string;
  instruction: string;
  schemaDesc: string;
  domText: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}

async function callOllama(args: OllamaCallArgs): Promise<unknown> {
  const prompt = [
    `You are a structured data extractor.`,
    `Task: ${args.instruction}`,
    `Fields to extract (TypeScript/Zod-like):`,
    args.schemaDesc,
    `Page content:`,
    args.domText,
    `Respond ONLY with valid JSON that matches the fields above. No prose, no markdown fences.`,
  ].join('\n\n');

  const res = await args.fetchImpl(`${args.url.replace(/\/$/, '')}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: args.model, prompt, stream: false, format: 'json' }),
    signal: args.signal,
  });
  if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
  const body: any = await res.json();
  const raw: string | undefined = body?.response ?? body?.message?.content;
  if (!raw) throw new Error('Ollama response missing "response" field');
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    // Attempt to find first {...} block
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Ollama returned non-JSON response: ${trimmed.slice(0, 200)}`);
  }
}

/**
 * Extract structured data from a page via NL instruction + Zod schema.
 * Heuristic first (regex/keyword scrape of visible text). Falls back to
 * Ollama only when heuristic fails AND opts.ollamaEnabled.
 */
export async function extractFromPage<S extends ZodTypeAny>(
  page: Page,
  instruction: string,
  schema: S,
  opts: ExtractOptions = {},
): Promise<ExtractResult<z.infer<S>>> {
  const maxChars = opts.maxTextChars ?? 12000;
  const text = opts.text ?? (await scrapeVisibleText(page, maxChars));
  const descriptors = describeSchema(schema);

  // Heuristic path
  if (descriptors.length > 0 && text) {
    const result: Record<string, unknown> = {};
    const confidences: number[] = [];
    let matched = 0;
    for (const d of descriptors) {
      const hit = heuristicExtractField(text, d);
      if (hit) {
        result[d.key] = hit.value;
        confidences.push(hit.confidence);
        matched += 1;
      } else if (d.optional) {
        // leave undefined
      }
    }
    const requiredCount = descriptors.filter((d) => !d.optional).length;
    const requiredMatched = descriptors
      .filter((d) => !d.optional)
      .every((d) => result[d.key] !== undefined);

    if (requiredMatched && matched > 0) {
      const candidate = descriptors.length === 1 && descriptors[0].key === 'value'
        ? result.value
        : result;
      const parsed = schema.safeParse(candidate);
      if (parsed.success) {
        const confidence = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0.6;
        return { data: parsed.data, source: 'heuristic', confidence };
      }
    }
    // single-field schema where key doesn't match — try parsing whole text
    if (descriptors.length === 1) {
      const single = descriptors[0];
      const hit = heuristicExtractField(text, { ...single, key: single.key });
      if (hit) {
        const parsed = schema.safeParse(hit.value);
        if (parsed.success) return { data: parsed.data, source: 'heuristic', confidence: hit.confidence };
      }
    }
    void requiredCount;
  }

  // LLM fallback
  if (opts.ollamaEnabled) {
    const url = opts.ollamaUrl ?? process.env.OLLAMA_URL ?? 'http://localhost:11434';
    const model = opts.ollamaModel ?? process.env.OLLAMA_MODEL ?? 'llama3';
    const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
    if (!fetchImpl) {
      throw new Error(`extract: heuristic failed and no fetch available for Ollama fallback`);
    }
    const domText = opts.html ?? (text || (await scrapeHtml(page, maxChars)));
    const schemaDesc = buildSchemaDescription(descriptors);
    let raw: unknown;
    try {
      raw = await callOllama({ url, model, instruction, schemaDesc, domText, fetchImpl, signal: opts.signal });
    } catch (e: any) {
      throw new Error(`extract: heuristic failed; Ollama fallback failed: ${e?.message ?? e}`);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`extract: Ollama response did not match schema: ${parsed.error.message}`);
    }
    return { data: parsed.data, source: 'llm', confidence: 0.7 };
  }

  throw new Error(
    `extract: heuristic extraction failed for instruction "${instruction}" and Ollama fallback is disabled. ` +
      `Set ollamaEnabled: true (or config.ai.extract.ollama) to enable LLM fallback.`,
  );
}

/** Registry for named Zod schemas that can be referenced from flow steps. */
export type SchemaRegistry = Record<string, ZodTypeAny>;

/** Build a schema registry. Pass-through helper that is explicit about intent. */
export function defineSchemas<T extends SchemaRegistry>(schemas: T): T {
  return schemas;
}
