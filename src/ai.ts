import type { Page, Locator } from 'playwright';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  LocatorCache,
  hashKey,
  type CacheEntry,
  type CacheStats,
  type HashInput,
} from './locator-cache.js';

export interface AIHelperOptions {
  model?: string;
  headless?: boolean;
  /**
   * Legacy JSON cache path (e.g. `<outputDir>/ai-cache.json`). When set and
   * `locatorCacheDbPath` is not, the cache falls back to a JSON file to stay
   * compatible with older callers.
   */
  cachePath?: string;
  /**
   * Preferred: absolute path to the shared SQLite history DB (e.g.
   * `.uxinspect/history.db`). When provided the locator cache piggybacks on
   * the same DB file the rest of the run history lives in.
   */
  locatorCacheDbPath?: string;
  /** Max entries before LRU eviction. Defaults to 10_000. */
  locatorCacheMaxEntries?: number;
  /**
   * Metadata fed into the cache key. Adding `url` + `viewport` makes the cache
   * robust against selector collisions between routes / breakpoints.
   */
  keyContext?: { url?: string; viewport?: string };
}

type Verb = 'click' | 'type' | 'fill' | 'check' | 'uncheck' | 'select' | 'hover' | 'press';

interface ParsedInstruction {
  verb: Verb;
  target: string;
  value?: string;
}

export class AIHelper {
  private _page: Page | null = null;
  private opts: AIHelperOptions;
  private cache: LocatorCache;
  private cacheLoaded = false;

  constructor(opts: AIHelperOptions = {}) {
    this.opts = opts;
    this.cache = new LocatorCache({
      dbPath: opts.locatorCacheDbPath,
      jsonPath: opts.locatorCacheDbPath ? undefined : opts.cachePath,
      maxEntries: opts.locatorCacheMaxEntries,
    });
  }

  async init(page?: Page): Promise<Page | null> {
    this._page = page ?? null;
    await this.loadCache();
    return this._page;
  }

  get page(): Page | null {
    return this._page;
  }

  /** Expose cache stats for the CLI / reporters. */
  getCacheStats(): CacheStats {
    return this.cache.getStats();
  }

  /** Update the URL/viewport used when hashing cache keys. Call per-page navigation. */
  setKeyContext(ctx: { url?: string; viewport?: string }): void {
    this.opts.keyContext = { ...this.opts.keyContext, ...ctx };
  }

  async act(instruction: string): Promise<boolean> {
    if (!this._page) return false;
    const parsed = parseInstruction(instruction);
    if (!parsed) return false;
    const key = this.buildKey(instruction);
    const cached = this.cache.get(key);
    let loc: Locator | null = null;
    if (cached) {
      loc = locatorFromCache(this._page, cached);
      // Validation: cached selector must still resolve on the live page.
      if (loc && !(await loc.count().catch(() => 0))) {
        this.cache.invalidate(key);
        loc = null;
      }
    }
    if (!loc) {
      loc = await resolveLocator(this._page, parsed.target, parsed.verb);
      if (loc) await this.rememberLocator(key, loc, parsed.verb);
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

  private buildKey(instruction: string): string {
    const ctx: HashInput = { instruction };
    if (this.opts.keyContext?.url) ctx.url = this.opts.keyContext.url;
    else if (this._page) {
      try { ctx.url = this._page.url(); } catch { /* ignore */ }
    }
    if (this.opts.keyContext?.viewport) ctx.viewport = this.opts.keyContext.viewport;
    else if (this._page) {
      try {
        const v = this._page.viewportSize();
        if (v) ctx.viewport = `${v.width}x${v.height}`;
      } catch { /* ignore */ }
    }
    return hashKey(ctx);
  }

  private async loadCache(): Promise<void> {
    if (this.cacheLoaded) return;
    // Legacy JSON path support: if the caller gave us `cachePath` only, we
    // still attempt a raw read so previously-saved records (string-keyed) can
    // be migrated silently. Unknown-shape files are ignored.
    if (this.opts.cachePath && !this.opts.locatorCacheDbPath) {
      await this.migrateLegacyJsonIfPresent();
    }
    await this.cache.load();
    this.cacheLoaded = true;
  }

  private async saveCache(): Promise<void> {
    await this.cache.save();
  }

  private async migrateLegacyJsonIfPresent(): Promise<void> {
    if (!this.opts.cachePath) return;
    try {
      const raw = await fs.readFile(this.opts.cachePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object') return;
      // New shape (written by LocatorCache.saveJson) already has `entries`.
      if ('entries' in (parsed as Record<string, unknown>)) return;
      // Old shape: Record<instruction, {strategy, value, verb}>.
      const old = parsed as Record<string, { strategy?: string; value?: string; verb?: string }>;
      const now = Date.now();
      for (const [instr, v] of Object.entries(old)) {
        if (!v || typeof v !== 'object' || !v.strategy || !v.value) continue;
        const key = hashKey({ instruction: instr });
        this.cache.put({
          key,
          resolvedSelector: v.value,
          confidence: 0.5,
          strategy: v.strategy as CacheEntry['strategy'],
          verb: v.verb ?? 'click',
          lastUsed: now,
          hits: 0,
        });
      }
      // Rewrite in the new format so subsequent loads are cheap.
      await fs.mkdir(path.dirname(this.opts.cachePath), { recursive: true });
    } catch {
      /* missing or unreadable — fine */
    }
  }

  private async rememberLocator(key: string, loc: Locator, verb: string): Promise<void> {
    try {
      const hint = await loc.evaluate(
        (el: Element) => ({
          role: (el as HTMLElement).getAttribute('role') ?? '',
          name: (el as HTMLElement).getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 60),
          id: (el as HTMLElement).id,
          dataTestId: (el as HTMLElement).getAttribute('data-testid') ?? '',
          tag: el.tagName.toLowerCase(),
        }),
      );
      let strategy: CacheEntry['strategy'] = 'text';
      let value = hint.name;
      let confidence = 0.5;
      if (hint.dataTestId) {
        strategy = 'testid';
        value = hint.dataTestId;
        confidence = 0.95;
      } else if (hint.id) {
        strategy = 'css';
        value = `#${hint.id}`;
        confidence = 0.85;
      } else if (hint.role && hint.name) {
        strategy = 'role';
        value = `${hint.role}|${hint.name}`;
        confidence = 0.75;
      }
      if (!value) return;
      this.cache.put({
        key,
        resolvedSelector: value,
        confidence,
        strategy,
        verb,
      });
    } catch {
      /* ignore */
    }
  }
}

function locatorFromCache(page: Page, c: CacheEntry): Locator | null {
  try {
    const value = c.resolvedSelector;
    if (c.strategy === 'testid') return page.getByTestId(value).first();
    if (c.strategy === 'css') return page.locator(value).first();
    if (c.strategy === 'role') {
      const [role, ...rest] = value.split('|');
      const name = rest.join('|');
      return page.getByRole(role as any, { name: new RegExp(escapeRegExp(name), 'i') }).first();
    }
    if (c.strategy === 'label') return page.getByLabel(value).first();
    if (c.strategy === 'placeholder') return page.getByPlaceholder(value).first();
    if (c.strategy === 'title') return page.getByTitle(value).first();
    if (c.strategy === 'text') return page.getByText(value, { exact: false }).first();
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
