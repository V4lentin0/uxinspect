import type { Page, Locator } from 'playwright';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface OllamaFallbackConfig {
  enabled?: boolean;
  url?: string;
  model?: string;
  timeoutMs?: number;
}

export interface AIFallbackConfig {
  ollama?: OllamaFallbackConfig;
}

export interface AIHelperOptions {
  model?: string;
  headless?: boolean;
  cachePath?: string;
  /** In-memory cache TTL (ms). Default 30 minutes. 0 disables TTL (never expires in-session). */
  cacheTtlMs?: number;
  fallback?: AIFallbackConfig;
}

export type LocatorStrategy = 'testid' | 'css' | 'role' | 'label' | 'placeholder' | 'title' | 'text';

export interface CachedLocator {
  strategy: LocatorStrategy | string;
  value: string;
  verb: string;
  /** Cache key: hash of (instruction + url + DOM signature). */
  key?: string;
  /** Wall-clock ms timestamp when cached (for TTL). */
  savedAt?: number;
}

type LocatorCache = Record<string, CachedLocator>;

type Verb = 'click' | 'type' | 'fill' | 'check' | 'uncheck' | 'select' | 'hover' | 'press';

interface ParsedInstruction {
  verb: Verb;
  target: string;
  value?: string;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'llama3.2';
const DEFAULT_OLLAMA_TIMEOUT_MS = 10_000;
const DOM_SNIPPET_MAX_CHARS = 3000;

export class AIHelper {
  private _page: Page | null = null;
  private opts: AIHelperOptions;
  private cache: LocatorCache = {};
  private cacheLoaded = false;

  constructor(opts: AIHelperOptions = {}) {
    this.opts = opts;
  }

  async init(page?: Page): Promise<Page | null> {
    this._page = page ?? null;
    await this.loadCache();
    return this._page;
  }

  get page(): Page | null {
    return this._page;
  }

  async act(instruction: string): Promise<boolean> {
    if (!this._page) return false;
    const parsed = parseInstruction(instruction);
    if (!parsed) return false;

    const key = await this.computeCacheKey(instruction);
    let loc: Locator | null = null;

    // Cache hit → skip heuristic chain
    const cached = this.getCached(key, instruction);
    if (cached) {
      loc = locatorFromCache(this._page, cached);
      const hasHit = loc ? await loc.count().catch(() => 0) : 0;
      if (!hasHit) {
        // Stale selector → evict and fall through to heuristic
        this.evictCache(key, instruction);
        loc = null;
      }
    }

    if (!loc) {
      loc = await resolveLocator(this._page, parsed.target, parsed.verb);

      // Heuristic exhausted → optional Ollama fallback
      if (!loc) {
        const fromLLM = await this.tryOllamaFallback(this._page, instruction, parsed);
        if (fromLLM) {
          loc = fromLLM.locator;
          // Persist Ollama-derived selector under cache so future runs skip the LLM roundtrip.
          this.storeCache(key, instruction, {
            strategy: 'css',
            value: fromLLM.selector,
            verb: parsed.verb,
          });
        }
      } else {
        await this.rememberLocator(key, instruction, loc, parsed.verb);
      }
    }

    if (!loc) return false;
    try {
      switch (parsed.verb) {
        case 'click':
          await loc.click({ timeout: 5000 });
          return true;
        case 'hover':
          await loc.hover({ timeout: 5000 });
          return true;
        case 'type':
          await loc.type(parsed.value ?? '', { timeout: 5000 });
          return true;
        case 'fill':
          await loc.fill(parsed.value ?? '', { timeout: 5000 });
          return true;
        case 'check':
          await loc.check({ timeout: 5000 });
          return true;
        case 'uncheck':
          await loc.uncheck({ timeout: 5000 });
          return true;
        case 'select':
          await loc.selectOption(parsed.value ?? '', { timeout: 5000 });
          return true;
        case 'press':
          await loc.press(parsed.value ?? 'Enter', { timeout: 5000 });
          return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  async extract(instruction: string): Promise<string | null> {
    if (!this._page) return null;
    const target = stripVerb(instruction, ['extract', 'get', 'read', 'find']);
    const loc = await resolveLocator(this._page, target, 'click');
    if (!loc) return null;
    try {
      return (await loc.innerText({ timeout: 3000 })).trim();
    } catch {
      return null;
    }
  }

  async observe(instruction: string): Promise<string[]> {
    if (!this._page) return [];
    const target = stripVerb(instruction, ['observe', 'find', 'list', 'show']);
    const candidates = await candidateLocators(this._page, target);
    const out: string[] = [];
    for (const c of candidates.slice(0, 20)) {
      const txt = await c.innerText({ timeout: 1000 }).catch(() => '');
      if (txt.trim()) out.push(txt.trim().slice(0, 80));
    }
    return out;
  }

  async close(): Promise<void> {
    this._page = null;
    await this.saveCache();
  }

  isAvailable(): boolean {
    return this._page !== null;
  }

  /** Exposed for tests: current cache size. */
  cacheSize(): number {
    return Object.keys(this.cache).length;
  }

  /** Exposed for tests: does a lookup-equivalent entry exist? */
  hasCached(instruction: string): boolean {
    // Any entry keyed by this instruction (primary or key-based) is a hit.
    if (this.cache[instruction]) return true;
    return Object.values(this.cache).some((c) => c && c.key && this.cache[c.key] === c);
  }

  private async computeCacheKey(instruction: string): Promise<string> {
    const page = this._page;
    let url = '';
    let signature = '';
    if (page) {
      try {
        url = page.url();
      } catch {
        url = '';
      }
      try {
        signature = await page.evaluate(() => {
          // Lightweight DOM signature: tag counts + body size + title.
          const tags = document.querySelectorAll('*');
          const counts: Record<string, number> = {};
          for (let i = 0; i < Math.min(tags.length, 500); i++) {
            const t = tags[i]!.tagName;
            counts[t] = (counts[t] ?? 0) + 1;
          }
          const bodyLen = (document.body?.innerHTML ?? '').length;
          return JSON.stringify({
            title: document.title,
            bodyLen,
            counts,
          });
        });
      } catch {
        signature = '';
      }
    }
    return sha1(`${instruction}::${url}::${signature}`);
  }

  private getCached(key: string, instruction: string): CachedLocator | null {
    const byKey = this.cache[key];
    const byInstr = this.cache[instruction];
    const entry = byKey ?? byInstr;
    if (!entry) return null;
    const ttl = this.opts.cacheTtlMs ?? DEFAULT_TTL_MS;
    if (ttl > 0 && entry.savedAt && Date.now() - entry.savedAt > ttl) {
      // Expired
      if (byKey) delete this.cache[key];
      if (byInstr) delete this.cache[instruction];
      return null;
    }
    return entry;
  }

  private evictCache(key: string, instruction: string): void {
    delete this.cache[key];
    delete this.cache[instruction];
  }

  private storeCache(key: string, instruction: string, payload: Omit<CachedLocator, 'key' | 'savedAt'>): void {
    const entry: CachedLocator = {
      ...payload,
      key,
      savedAt: Date.now(),
    };
    this.cache[key] = entry;
    this.cache[instruction] = entry;
  }

  private async loadCache(): Promise<void> {
    if (this.cacheLoaded || !this.opts.cachePath) return;
    try {
      this.cache = JSON.parse(await fs.readFile(this.opts.cachePath, 'utf8'));
    } catch {
      this.cache = {};
    }
    this.cacheLoaded = true;
  }

  private async saveCache(): Promise<void> {
    if (!this.opts.cachePath) return;
    await fs.mkdir(path.dirname(this.opts.cachePath), { recursive: true });
    await fs.writeFile(this.opts.cachePath, JSON.stringify(this.cache, null, 2));
  }

  private async rememberLocator(
    key: string,
    instruction: string,
    loc: Locator,
    verb: string,
  ): Promise<void> {
    try {
      const hint = await loc.evaluate(
        (el: Element) => ({
          role: (el as HTMLElement).getAttribute('role') ?? '',
          name:
            (el as HTMLElement).getAttribute('aria-label') ??
            (el.textContent ?? '').trim().slice(0, 60),
          id: (el as HTMLElement).id,
          dataTestId: (el as HTMLElement).getAttribute('data-testid') ?? '',
          tag: el.tagName.toLowerCase(),
        }),
      );
      let strategy: LocatorStrategy = 'text';
      let value = hint.name;
      if (hint.dataTestId) {
        strategy = 'testid';
        value = hint.dataTestId;
      } else if (hint.id) {
        strategy = 'css';
        value = `#${hint.id}`;
      } else if (hint.role && hint.name) {
        strategy = 'role';
        value = `${hint.role}|${hint.name}`;
      }
      this.storeCache(key, instruction, { strategy, value, verb });
    } catch {
      /* ignore */
    }
  }

  private async tryOllamaFallback(
    page: Page,
    instruction: string,
    parsed: ParsedInstruction,
  ): Promise<{ selector: string; locator: Locator } | null> {
    const cfg = this.opts.fallback?.ollama;
    if (!cfg?.enabled) return null;

    const url = (cfg.url ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
    const model = cfg.model ?? DEFAULT_OLLAMA_MODEL;
    const timeoutMs = cfg.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS;

    let snippet = '';
    try {
      snippet = await page.evaluate(() => document.body?.outerHTML ?? '');
    } catch {
      snippet = '';
    }
    if (snippet.length > DOM_SNIPPET_MAX_CHARS) snippet = snippet.slice(0, DOM_SNIPPET_MAX_CHARS);

    const prompt =
      `Given this DOM snippet [${snippet}] and instruction [${instruction}] (verb=${parsed.verb}, target=${parsed.target}), ` +
      `return ONLY a valid CSS selector that targets the matching element. ` +
      `No explanation, no markdown, just the selector on a single line.`;

    let raw: string;
    try {
      raw = await ollamaGenerate(url, model, prompt, timeoutMs);
    } catch {
      return null;
    }

    const selector = extractCssSelector(raw);
    if (!selector) return null;
    try {
      const locator = page.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (!count) return null;
      return { selector, locator };
    } catch {
      return null;
    }
  }
}

export async function ollamaGenerate(
  baseUrl: string,
  model: string,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const data = (await res.json()) as { response?: string };
    return (data.response ?? '').trim();
  } finally {
    clearTimeout(timer);
  }
}

export function extractCssSelector(raw: string): string | null {
  if (!raw) return null;
  let s = raw.trim();
  // Strip markdown code fences ```css ... ``` or ``` ... ```
  const fence = s.match(/```[a-zA-Z]*\s*([\s\S]*?)```/);
  if (fence) s = fence[1]!.trim();
  // Take the first non-empty line.
  s = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? '';
  // Strip leading prose like "Selector:" or "The selector is".
  s = s.replace(/^(css\s+selector[:\s]*|selector[:\s]*)/i, '').trim();
  // Strip wrapping quotes/backticks.
  s = s.replace(/^[`'"]+|[`'"]+$/g, '').trim();
  if (!s) return null;
  if (!isValidCssSelector(s)) return null;
  return s;
}

function isValidCssSelector(s: string): boolean {
  if (s.length > 1000) return false;
  // Must contain at least one selector-ish char and no line breaks.
  if (/[\n\r]/.test(s)) return false;
  // Rough shape check: starts with #, ., [, *, or an identifier/tag.
  if (!/^[#.\[*:a-zA-Z]/.test(s)) return false;
  // Reject obvious prose.
  if (/\s(is|the|a|an)\s/i.test(s)) return false;
  return true;
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

function locatorFromCache(page: Page, c: { strategy: string; value: string }): Locator | null {
  try {
    if (c.strategy === 'testid') return page.getByTestId(c.value).first();
    if (c.strategy === 'css') return page.locator(c.value).first();
    if (c.strategy === 'role') {
      const [role, ...rest] = c.value.split('|');
      const name = rest.join('|');
      return page.getByRole(role as any, { name: new RegExp(escapeRegExp(name), 'i') }).first();
    }
    if (c.strategy === 'label') return page.getByLabel(c.value).first();
    if (c.strategy === 'placeholder') return page.getByPlaceholder(c.value).first();
    if (c.strategy === 'title') return page.getByTitle(c.value).first();
    if (c.strategy === 'text') return page.getByText(c.value, { exact: false }).first();
  } catch {
    return null;
  }
  return null;
}

const VERB_MAP: Record<string, Verb> = {
  click: 'click',
  tap: 'click',
  press: 'press',
  hit: 'click',
  select: 'select',
  choose: 'select',
  pick: 'click',
  type: 'type',
  enter: 'fill',
  fill: 'fill',
  input: 'fill',
  write: 'fill',
  check: 'check',
  tick: 'check',
  uncheck: 'uncheck',
  hover: 'hover',
  mouseover: 'hover',
};

function parseInstruction(instr: string): ParsedInstruction | null {
  const s = instr.trim();
  const m = s.match(/^(\w+)\s+(.+)$/i);
  if (!m) return null;
  const verbWord = m[1]!.toLowerCase();
  const verb = VERB_MAP[verbWord];
  if (!verb) return null;
  const rest = m[2]!;

  if (verb === 'type' || verb === 'fill') {
    const quote = rest.match(/['"]([^'"]+)['"]/);
    if (quote) {
      const value = quote[1]!;
      const target = rest.replace(quote[0]!, '').replace(/\b(in|into|to)\b/gi, '').trim();
      return { verb, target, value };
    }
    const intoMatch = rest.match(/^(.+?)\s+(?:in|into|to)\s+(.+)$/i);
    if (intoMatch) return { verb, target: intoMatch[2]!, value: intoMatch[1]! };
    return { verb, target: rest, value: '' };
  }

  if (verb === 'select') {
    const m2 = rest.match(/^['"]?(.+?)['"]?\s+(?:from|in)\s+(.+)$/i);
    if (m2) return { verb, target: m2[2]!, value: m2[1]! };
  }

  if (verb === 'press') {
    const keyMatch = rest.match(/^(\w+)(?:\s+(?:on|in)\s+(.+))?$/i);
    if (keyMatch) return { verb, target: keyMatch[2] ?? 'body', value: keyMatch[1]! };
  }

  return { verb, target: rest };
}

function stripVerb(instr: string, verbs: string[]): string {
  const re = new RegExp(`^(${verbs.join('|')})\\s+`, 'i');
  return instr.replace(re, '').trim();
}

function cleanTarget(t: string): string {
  return t
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/\s+(button|link|input|field|dropdown|menu|tab|checkbox|radio|form|element)$/i, '')
    .trim();
}

async function resolveLocator(page: Page, rawTarget: string, verb: Verb): Promise<Locator | null> {
  const target = cleanTarget(rawTarget);
  const re = new RegExp(escapeRegExp(target), 'i');

  const roleForVerb: Record<Verb, string[]> = {
    click: ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio'],
    hover: ['button', 'link', 'menuitem', 'tab'],
    type: ['textbox', 'searchbox', 'combobox'],
    fill: ['textbox', 'searchbox', 'combobox'],
    check: ['checkbox', 'radio'],
    uncheck: ['checkbox', 'radio'],
    select: ['combobox', 'listbox'],
    press: ['textbox', 'searchbox', 'button', 'link'],
  };

  for (const role of roleForVerb[verb]) {
    const loc = page.getByRole(role as any, { name: re }).first();
    if (await loc.count().catch(() => 0)) return loc;
  }

  const byLabel = page.getByLabel(re).first();
  if (await byLabel.count().catch(() => 0)) return byLabel;

  const byPlaceholder = page.getByPlaceholder(re).first();
  if (await byPlaceholder.count().catch(() => 0)) return byPlaceholder;

  const byTitle = page.getByTitle(re).first();
  if (await byTitle.count().catch(() => 0)) return byTitle;

  if (verb === 'click' || verb === 'hover') {
    const byText = page.getByText(re, { exact: false }).first();
    if (await byText.count().catch(() => 0)) return byText;
  }

  if (target.startsWith('#') || target.startsWith('.') || target.includes('[')) {
    const css = page.locator(target).first();
    if (await css.count().catch(() => 0)) return css;
  }

  return null;
}

async function candidateLocators(page: Page, rawTarget: string): Promise<Locator[]> {
  const target = cleanTarget(rawTarget);
  const re = new RegExp(escapeRegExp(target), 'i');
  const out: Locator[] = [];
  for (const role of ['button', 'link', 'heading', 'textbox', 'menuitem', 'tab']) {
    const all = await page.getByRole(role as any, { name: re }).all().catch(() => []);
    out.push(...all);
  }
  const txt = await page.getByText(re).all().catch(() => []);
  out.push(...txt);
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
