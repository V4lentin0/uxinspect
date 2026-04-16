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
  /** Disable self-healing when a cached/original locator fails (default: enabled). */
  selfHeal?: boolean;
  /** Optional LLM hook used as last-resort healing strategy (P3 #27). */
  llmHealHook?: (ctx: LlmHealContext) => Promise<string | null>;
}

/** Strategy names used by self-heal events + cache. */
export type HealStrategy =
  | 'reresolve'
  | 'role-name'
  | 'text'
  | 'testid-neighborhood'
  | 'xpath-similarity'
  | 'llm';

export interface SelfHealEvent {
  /** Natural-language step instruction that triggered the heal. */
  instruction: string;
  /** Selector / strategy-value that failed before self-heal ran. */
  failedSelector: string;
  /** The strategy that ultimately worked. */
  healedWith: HealStrategy;
  /** The new selector that resolved the element, in a form ingestible by the cache. */
  newSelector: string;
  /** Wall-clock ms when the heal was performed. */
  at: number;
  /** Optional page URL for report grouping. */
  url?: string;
}

export interface LlmHealContext {
  instruction: string;
  target: string;
  verb: string;
  failedSelector: string;
  /** Small DOM snapshot excerpt (body.outerHTML capped at 3k chars). */
  domSnippet: string;
  /** Optional screenshot buffer (base64 PNG) when available. */
  screenshot?: string;
}

/**
 * Legacy locator shape used by older callers. Kept for selectorToCacheEntry
 * export compatibility — the runtime cache now uses `CacheEntry` from
 * `./locator-cache.js` (P2 #25).
 */
export interface CachedLocator {
  strategy: string;
  value: string;
  verb: string;
  /** Bump each time self-heal rewrites this entry (P2 #26). */
  heals?: number;
  /** Timestamp (ms) of most recent heal. */
  lastHealAt?: number;
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
  private healEvents: SelfHealEvent[] = [];
  /** Instruction → true while a self-heal is running. Prevents recursive heal attempts. */
  private healing = new Set<string>();

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
    let cachedFailed = false;
    let cacheSelector = '';

    if (cached) {
      cacheSelector = cachedToString(cached);
      loc = locatorFromCache(this._page, cached);
      // Validation: cached selector must still resolve on the live page.
      if (loc && !(await loc.count().catch(() => 0))) {
        this.cache.invalidate(key);
        loc = null;
        cachedFailed = true;
      }
    }

    if (!loc) {
      loc = await resolveLocator(this._page, parsed.target, parsed.verb);
      if (loc) {
        // Fresh-resolve success after a failed cached selector IS a self-heal:
        // record an event and bump the heals counter.
        if (cachedFailed && this.selfHealEnabled()) {
          const newSelector = (await describeLocator(loc).catch(() => '')) || `text=${parsed.target}`;
          this.recordHeal(this._page, instruction, cacheSelector, 'reresolve', newSelector);
          this.updateCacheForHeal(key, instruction, parsed.verb, 'reresolve', newSelector);
        } else {
          await this.rememberLocator(key, loc, parsed.verb);
        }
      }
    }

    // If both cache and fresh heuristic failed, attempt a single self-heal pass
    // with the remaining neighbouring strategies.
    if (!loc && this.selfHealEnabled() && !this.healing.has(instruction)) {
      const healed = await this.runSelfHeal(
        instruction,
        cachedFailed ? cacheSelector : '(no cached selector)',
        parsed,
      );
      if (healed) loc = healed.locator;
    }

    if (!loc) return false;
    try {
      return await performVerb(loc, parsed);
    } catch {
      // Action itself (click/type/etc) blew up. Try one self-heal pass against a
      // fresh snapshot, then retry the verb exactly once.
      if (this.selfHealEnabled() && !this.healing.has(instruction)) {
        const healed = await this.runSelfHeal(
          instruction,
          cacheSelector || '(action-error)',
          parsed,
        );
        if (healed) {
          try {
            return await performVerb(healed.locator, parsed);
          } catch {
            return false;
          }
        }
      }
      return false;
    }
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

  /** Return the currently-recorded self-heal events (used for reporting). */
  getHealEvents(): SelfHealEvent[] {
    return [...this.healEvents];
  }

  /** Reset the heal-event log (tests / per-flow reporting). */
  clearHealEvents(): void {
    this.healEvents = [];
  }

  /**
   * Attempt to recover from a failing locator by trying neighbouring strategies
   * (P2 #26). Returns the new selector + strategy on success, `null` otherwise.
   *
   * Retry order:
   *   1. Fresh heuristic re-resolve (skips cache)
   *   2. `getByRole(role, { name })` using role guessed from failed selector's tag
   *   3. `getByText(description)` fuzzy match
   *   4. data-testid neighbourhood walk around the failed selector's parent
   *   5. XPath similarity (tag + attr pattern)
   *   6. LLM fallback (opt-in via `opts.llmHealHook`)
   */
  async selfHeal(
    originalDescription: string,
    failedSelector: string,
    page?: Page,
  ): Promise<{ selector: string; strategy: HealStrategy } | null> {
    const target = page ?? this._page;
    if (!target) return null;
    const parsed = parseInstruction(originalDescription) ?? {
      verb: 'click' as Verb,
      target: originalDescription,
    };
    const healed = await this.runSelfHeal(originalDescription, failedSelector, parsed, target);
    if (!healed) return null;
    return { selector: healed.newSelector, strategy: healed.strategy };
  }

  private selfHealEnabled(): boolean {
    return this.opts.selfHeal !== false;
  }

  private async runSelfHeal(
    instruction: string,
    failedSelector: string,
    parsed: ParsedInstruction,
    pageOverride?: Page,
  ): Promise<{ locator: Locator; strategy: HealStrategy; newSelector: string } | null> {
    const page = pageOverride ?? this._page;
    if (!page || this.healing.has(instruction)) return null;
    this.healing.add(instruction);
    try {
      const strategies: (() => Promise<{
        locator: Locator;
        strategy: HealStrategy;
        newSelector: string;
      } | null>)[] = [
        () => this.healReresolve(page, parsed),
        () => this.healByRoleName(page, parsed, failedSelector),
        () => this.healByText(page, parsed),
        () => this.healByTestIdNeighborhood(page, parsed, failedSelector),
        () => this.healByXPathSimilarity(page, parsed, failedSelector),
        () => this.healByLlm(page, instruction, parsed, failedSelector),
      ];

      for (const s of strategies) {
        let result: {
          locator: Locator;
          strategy: HealStrategy;
          newSelector: string;
        } | null = null;
        try {
          result = await s();
        } catch {
          result = null;
        }
        if (!result) continue;
        const cnt = await result.locator.count().catch(() => 0);
        if (!cnt) continue;
        this.recordHeal(page, instruction, failedSelector, result.strategy, result.newSelector);
        this.updateCacheForHeal(this.buildKey(instruction), instruction, parsed.verb, result.strategy, result.newSelector);
        return result;
      }
      return null;
    } finally {
      this.healing.delete(instruction);
    }
  }

  private async healReresolve(
    page: Page,
    parsed: ParsedInstruction,
  ): Promise<{ locator: Locator; strategy: HealStrategy; newSelector: string } | null> {
    const loc = await resolveLocator(page, parsed.target, parsed.verb);
    if (!loc) return null;
    const sel = await describeLocator(loc).catch(() => '');
    return { locator: loc, strategy: 'reresolve', newSelector: sel || `text=${parsed.target}` };
  }

  private async healByRoleName(
    page: Page,
    parsed: ParsedInstruction,
    failedSelector: string,
  ): Promise<{ locator: Locator; strategy: HealStrategy; newSelector: string } | null> {
    const role = guessRole(parsed.verb, failedSelector);
    if (!role) return null;
    const re = new RegExp(escapeRegExp(cleanTarget(parsed.target)), 'i');
    const loc = page.getByRole(role as any, { name: re }).first();
    if (!(await loc.count().catch(() => 0))) return null;
    return {
      locator: loc,
      strategy: 'role-name',
      newSelector: `role=${role}|${cleanTarget(parsed.target)}`,
    };
  }

  private async healByText(
    page: Page,
    parsed: ParsedInstruction,
  ): Promise<{ locator: Locator; strategy: HealStrategy; newSelector: string } | null> {
    const t = cleanTarget(parsed.target);
    if (!t) return null;
    const re = new RegExp(escapeRegExp(t), 'i');
    let loc = page.getByText(re, { exact: false }).first();
    if (!(await loc.count().catch(() => 0))) {
      const word = t.split(/\s+/).find((w) => w.length > 2);
      if (!word) return null;
      loc = page.getByText(new RegExp(escapeRegExp(word), 'i'), { exact: false }).first();
      if (!(await loc.count().catch(() => 0))) return null;
      return { locator: loc, strategy: 'text', newSelector: `text=${word}` };
    }
    return { locator: loc, strategy: 'text', newSelector: `text=${t}` };
  }

  private async healByTestIdNeighborhood(
    page: Page,
    parsed: ParsedInstruction,
    failedSelector: string,
  ): Promise<{ locator: Locator; strategy: HealStrategy; newSelector: string } | null> {
    const css = extractCssFromSelector(failedSelector);
    const target = cleanTarget(parsed.target).toLowerCase();
    const testId: string | null = await page
      .evaluate(
        (args: { css: string | null; target: string }) => {
          const doc = (globalThis as any).document;
          if (!doc) return null;
          const walk = (start: any): string | null => {
            const seen = new Set<any>();
            const queue: any[] = [start];
            while (queue.length) {
              const node = queue.shift();
              if (!node || seen.has(node)) continue;
              seen.add(node);
              const tid =
                (node.getAttribute && node.getAttribute('data-testid')) ||
                (node.getAttribute && node.getAttribute('data-test-id')) ||
                (node.getAttribute && node.getAttribute('data-test'));
              if (tid) {
                const txt = (node.textContent || '').toLowerCase();
                if (!args.target || txt.indexOf(args.target) !== -1) return tid;
              }
              if (node.children) {
                for (let i = 0; i < node.children.length; i++) queue.push(node.children[i]);
              }
            }
            return null;
          };
          let anchor: any = null;
          if (args.css) {
            try {
              anchor = doc.querySelector(args.css);
            } catch {
              anchor = null;
            }
          }
          if (anchor && anchor.parentElement) {
            const parent = anchor.parentElement;
            const found = walk(parent);
            if (found) return found;
          }
          if (args.target) {
            const all = doc.querySelectorAll('[data-testid],[data-test-id],[data-test]');
            for (let i = 0; i < all.length; i++) {
              const el = all[i];
              const txt = (el.textContent || '').toLowerCase();
              if (txt.indexOf(args.target) !== -1) {
                return (
                  el.getAttribute('data-testid') ||
                  el.getAttribute('data-test-id') ||
                  el.getAttribute('data-test') ||
                  null
                );
              }
            }
          }
          return null;
        },
        { css, target },
      )
      .catch(() => null);

    if (!testId) return null;
    const loc = page.getByTestId(testId).first();
    if (!(await loc.count().catch(() => 0))) return null;
    return {
      locator: loc,
      strategy: 'testid-neighborhood',
      newSelector: `testid=${testId}`,
    };
  }

  private async healByXPathSimilarity(
    page: Page,
    parsed: ParsedInstruction,
    failedSelector: string,
  ): Promise<{ locator: Locator; strategy: HealStrategy; newSelector: string } | null> {
    const hint = hintFromFailedSelector(failedSelector);
    const target = cleanTarget(parsed.target).toLowerCase();
    const foundSelector: string | null = await page
      .evaluate(
        (args: {
          hintTag: string;
          hintAttrs: Array<{ name: string; value: string }>;
          target: string;
        }) => {
          const doc = (globalThis as any).document;
          if (!doc) return null;
          const candidates = doc.querySelectorAll(args.hintTag || '*');
          let best: {
            tag: string;
            score: number;
            id?: string;
            cls?: string;
            testId?: string;
          } | null = null;
          for (let i = 0; i < candidates.length; i++) {
            const el = candidates[i];
            let score = 0;
            const txt = (el.textContent || '').toLowerCase();
            if (args.target && txt.indexOf(args.target) !== -1) score += 3;
            for (const a of args.hintAttrs) {
              const v = (el.getAttribute && el.getAttribute(a.name)) || '';
              if (v && v === a.value) score += 2;
              else if (v && a.value && v.indexOf(a.value) !== -1) score += 1;
            }
            if (score <= 0) continue;
            if (!best || score > best.score) {
              best = {
                tag: (el.tagName || '').toLowerCase(),
                score,
                id: el.id || undefined,
                cls:
                  typeof el.className === 'string' && el.className.trim()
                    ? el.className.split(/\s+/)[0]
                    : undefined,
                testId:
                  (el.getAttribute && el.getAttribute('data-testid')) ||
                  (el.getAttribute && el.getAttribute('data-test-id')) ||
                  undefined,
              };
            }
          }
          if (!best) return null;
          if (best.testId) return `[data-testid="${best.testId}"]`;
          if (best.id) return `#${best.id}`;
          if (best.cls) return `${best.tag}.${best.cls}`;
          return best.tag;
        },
        { hintTag: hint.tag, hintAttrs: hint.attrs, target },
      )
      .catch(() => null);

    if (!foundSelector) return null;
    const loc = page.locator(foundSelector).first();
    if (!(await loc.count().catch(() => 0))) return null;
    return { locator: loc, strategy: 'xpath-similarity', newSelector: `css=${foundSelector}` };
  }

  private async healByLlm(
    page: Page,
    instruction: string,
    parsed: ParsedInstruction,
    failedSelector: string,
  ): Promise<{ locator: Locator; strategy: HealStrategy; newSelector: string } | null> {
    const hook = this.opts.llmHealHook;
    if (!hook) return null;
    let domSnippet = '';
    try {
      domSnippet = await page.evaluate(() => (document.body?.outerHTML ?? '').slice(0, 3000));
    } catch {
      domSnippet = '';
    }
    let screenshot: string | undefined;
    try {
      const buf = await page.screenshot({ type: 'png', fullPage: false });
      screenshot = buf.toString('base64');
    } catch {
      screenshot = undefined;
    }
    let selector: string | null = null;
    try {
      selector = await hook({
        instruction,
        target: parsed.target,
        verb: parsed.verb,
        failedSelector,
        domSnippet,
        screenshot,
      });
    } catch {
      selector = null;
    }
    if (!selector) return null;
    try {
      const loc = page.locator(selector).first();
      if (!(await loc.count().catch(() => 0))) return null;
      return { locator: loc, strategy: 'llm', newSelector: `css=${selector}` };
    } catch {
      return null;
    }
  }

  private recordHeal(
    page: Page,
    instruction: string,
    failedSelector: string,
    strategy: HealStrategy,
    newSelector: string,
  ): void {
    let url: string | undefined;
    try {
      url = page.url();
    } catch {
      url = undefined;
    }
    this.healEvents.push({
      instruction,
      failedSelector,
      healedWith: strategy,
      newSelector,
      at: Date.now(),
      url,
    });
  }

  private updateCacheForHeal(
    key: string,
    _instruction: string,
    verb: string,
    strategy: HealStrategy,
    newSelector: string,
  ): void {
    const payload = selectorToCacheEntry(newSelector, verb);
    if (!payload) return;
    const prev = this.cache.peek(key);
    const heals = (prev?.heals ?? 0) + 1;
    this.cache.put({
      key,
      resolvedSelector: payload.value,
      confidence: strategy === 'llm' ? 0.5 : 0.75,
      strategy: payload.strategy as CacheEntry['strategy'],
      verb,
      lastUsed: Date.now(),
      hits: prev?.hits ?? 0,
      heals,
      lastHealAt: Date.now(),
    });
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
      // Fresh remember — the caller only reaches this path after either a
      // cache miss/invalidate or resolver-backed first-write, so there's no
      // in-memory `prev` to preserve heals from. Heal-path writes go through
      // `updateCacheForHeal` which carries heals forward itself.
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

async function performVerb(loc: Locator, parsed: ParsedInstruction): Promise<boolean> {
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
  return false;
}

function cachedToString(c: CacheEntry): string {
  return `${c.strategy}=${c.resolvedSelector}`;
}

async function describeLocator(loc: Locator): Promise<string> {
  try {
    return await loc.evaluate((el: Element) => {
      const html = el as HTMLElement;
      const tid = html.getAttribute('data-testid') ?? html.getAttribute('data-test-id');
      if (tid) return `testid=${tid}`;
      if (html.id) return `css=#${html.id}`;
      const role = html.getAttribute('role') ?? '';
      const name =
        html.getAttribute('aria-label') ?? (html.textContent ?? '').trim().slice(0, 60);
      if (role && name) return `role=${role}|${name}`;
      return `text=${(html.textContent ?? '').trim().slice(0, 60)}`;
    });
  } catch {
    return '';
  }
}

/**
 * Translate a newSelector string (produced by heal strategies) into a cache
 * entry compatible with the existing cache shape.
 */
export function selectorToCacheEntry(
  newSelector: string,
  verb: string,
): CachedLocator | null {
  if (!newSelector) return null;
  const s = newSelector.trim();
  if (s.startsWith('testid=')) return { strategy: 'testid', value: s.slice('testid='.length), verb };
  if (s.startsWith('css=')) return { strategy: 'css', value: s.slice('css='.length), verb };
  if (s.startsWith('role=')) return { strategy: 'role', value: s.slice('role='.length), verb };
  if (s.startsWith('text=')) return { strategy: 'text', value: s.slice('text='.length), verb };
  return { strategy: 'css', value: s, verb };
}

/**
 * Best-effort tag guess from a failed selector or verb.
 * Example: `css=.submit-btn` → click verb → role `button`.
 */
function guessRole(verb: Verb, failedSelector: string): string | null {
  const sel = failedSelector.toLowerCase();
  if (/\b(button|btn)\b/.test(sel)) return 'button';
  if (/\blink\b|<a\b/.test(sel)) return 'link';
  if (/input|textbox|textarea/.test(sel)) return 'textbox';
  if (/checkbox/.test(sel)) return 'checkbox';
  if (/radio/.test(sel)) return 'radio';
  if (/\btab\b/.test(sel)) return 'tab';
  if (/menu/.test(sel)) return 'menuitem';
  switch (verb) {
    case 'click':
    case 'hover':
      return 'button';
    case 'type':
    case 'fill':
    case 'press':
      return 'textbox';
    case 'check':
    case 'uncheck':
      return 'checkbox';
    case 'select':
      return 'combobox';
  }
  return null;
}

function extractCssFromSelector(s: string): string | null {
  if (!s) return null;
  if (s.startsWith('css=')) return s.slice('css='.length);
  if (s.startsWith('#') || s.startsWith('.') || s.startsWith('[')) return s;
  return null;
}

function hintFromFailedSelector(failedSelector: string): {
  tag: string;
  attrs: Array<{ name: string; value: string }>;
} {
  const out = { tag: '', attrs: [] as Array<{ name: string; value: string }> };
  if (!failedSelector) return out;
  const sel = failedSelector.replace(/^(css|testid|role|text)=/, '');
  const tagMatch = sel.match(/^([a-zA-Z][a-zA-Z0-9]*)/);
  if (tagMatch) out.tag = tagMatch[1]!;
  const attrRe = /\[([a-zA-Z_:][-\w:]*)(?:=['"]?([^"'\]]+)['"]?)?\]/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(sel))) {
    out.attrs.push({ name: m[1]!, value: m[2] ?? '' });
  }
  const clsMatch = sel.match(/\.([\w-]+)/);
  if (clsMatch) out.attrs.push({ name: 'class', value: clsMatch[1]! });
  const idMatch = sel.match(/#([\w-]+)/);
  if (idMatch) out.attrs.push({ name: 'id', value: idMatch[1]! });
  return out;
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

// ─────────────────────────────────────────────────────────────────
// P3 #27 — Ollama bridge (opt-in local language model fallback)
// ─────────────────────────────────────────────────────────────────

export interface OllamaFallbackOptions {
  /** Model name. Default 'llama3.2'. */
  model?: string;
  /** Endpoint URL. Default 'http://localhost:11434/api/generate'. */
  endpoint?: string;
  /** Timeout in ms. Default 10000. */
  timeout?: number;
}

const OLLAMA_DEFAULT_ENDPOINT = 'http://localhost:11434/api/generate';
const OLLAMA_DEFAULT_MODEL = 'llama3.2';
const OLLAMA_DEFAULT_TIMEOUT = 10_000;

const OLLAMA_SYSTEM_PROMPT = `You are an expert at finding HTML elements. Given a DOM snippet and an instruction describing a UI element, respond with ONLY a valid CSS selector that uniquely identifies the element. No explanation, no markdown, no backticks. Just the raw CSS selector.`;

/**
 * POST to a local language model endpoint to resolve a CSS selector
 * from a natural-language instruction + DOM context.
 *
 * Returns the selector string on success, null on any failure (unreachable,
 * timeout, invalid response). Never throws.
 */
export async function ollamaFallback(
  instruction: string,
  domSnippet: string,
  opts: OllamaFallbackOptions = {},
): Promise<string | null> {
  const endpoint = opts.endpoint ?? OLLAMA_DEFAULT_ENDPOINT;
  const model = opts.model ?? OLLAMA_DEFAULT_MODEL;
  const timeout = opts.timeout ?? OLLAMA_DEFAULT_TIMEOUT;

  const userPrompt = `Instruction: "${instruction}"\n\nDOM snippet:\n${domSnippet.slice(0, 3000)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        system: OLLAMA_SYSTEM_PROMPT,
        prompt: userPrompt,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { response?: string };
    if (!json.response) return null;
    return cleanOllamaResponse(json.response);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Strip markdown fences, backticks, and reject responses that look like
 * prose rather than a CSS selector.
 */
function cleanOllamaResponse(raw: string): string | null {
  let sel = raw.trim();
  // Strip markdown code fences
  sel = sel.replace(/^```[\w]*\n?/gm, '').replace(/\n?```$/gm, '');
  // Strip inline backticks
  sel = sel.replace(/^`+|`+$/g, '');
  sel = sel.trim();
  // Reject if it looks like prose (contains spaces + starts with uppercase letter word)
  if (/^[A-Z][a-z]+ /.test(sel) && sel.length > 60) return null;
  // Reject empty
  if (!sel) return null;
  return sel;
}

/**
 * Factory: create an `llmHealHook` from OllamaFallbackConfig that can be
 * passed into AIHelperOptions. Returns null (no-op) if config is absent or
 * disabled.
 */
export function createOllamaHealHook(
  cfg?: import('./types.js').OllamaFallbackConfig,
): ((ctx: LlmHealContext) => Promise<string | null>) | undefined {
  if (!cfg?.enabled) return undefined;
  return async (ctx: LlmHealContext): Promise<string | null> => {
    return ollamaFallback(ctx.instruction, ctx.domSnippet, {
      model: cfg.model,
      endpoint: cfg.endpoint,
      timeout: cfg.timeout,
    });
  };
}

// ─────────────────────────────────────────────────────────────────
// P3 #29 — NL observe() — discover interactive elements
// ─────────────────────────────────────────────────────────────────

import type { ObservableAction, ObserveOptions } from './types.js';

const INTERACTIVE_SELECTOR = [
  'a', 'button', 'input', 'select', 'textarea',
  '[role="button"]', '[role="link"]', '[role="tab"]',
  '[role="menuitem"]', '[role="checkbox"]', '[role="radio"]',
  '[onclick]', '[tabindex]',
].join(', ');

/**
 * Discover all interactive elements on the current page with human-readable
 * descriptions. Sorted by visual position (top-left first). Supports optional
 * substring filter and limit.
 */
export async function observe(
  page: Page,
  opts: ObserveOptions = {},
): Promise<ObservableAction[]> {
  const limit = opts.limit ?? 50;

  const raw: Array<{
    selector: string;
    tag: string;
    role: string;
    ariaLabel: string;
    text: string;
    href: string;
    type: string;
    name: string;
    placeholder: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }> = await page.evaluate((sel: string) => {
    const els = document.querySelectorAll(sel);
    const out: any[] = [];
    els.forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      const tag = el.tagName.toLowerCase();
      const id = el.id;
      const testId = el.getAttribute('data-testid');
      const ariaLabel = el.getAttribute('aria-label') || '';
      const role = el.getAttribute('role') || '';
      const text = (el.textContent || '').trim().slice(0, 80);
      const href = (el as HTMLAnchorElement).href || '';
      const type = (el as HTMLInputElement).type || '';
      const name = (el as HTMLInputElement).name || '';
      const placeholder = (el as HTMLInputElement).placeholder || '';

      let selector: string;
      if (testId) selector = `[data-testid="${testId}"]`;
      else if (id && !/^[0-9]/.test(id) && id.length < 50) selector = `#${id}`;
      else if (ariaLabel) selector = `[aria-label="${ariaLabel}"]`;
      else selector = `${tag}:nth-of-type(${Array.from(el.parentElement?.children || []).filter(c => c.tagName === el.tagName).indexOf(el) + 1})`;

      out.push({
        selector, tag, role, ariaLabel, text, href, type, name, placeholder,
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      });
    });
    return out;
  }, INTERACTIVE_SELECTOR);

  let actions: ObservableAction[] = raw
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((el) => ({
      selector: el.selector,
      description: describeElement(el),
      elementType: classifyElementType(el),
      visibleText: el.text,
      boundingBox: { x: el.x, y: el.y, width: el.width, height: el.height },
    }));

  if (opts.filter) {
    const f = opts.filter.toLowerCase();
    actions = actions.filter((a) => a.description.toLowerCase().includes(f));
  }

  return actions.slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────
// P3 #34 — AI-narrated step name generation
// ─────────────────────────────────────────────────────────────────

export interface DomContext {
  visibleText?: string;
  ariaLabel?: string;
  role?: string;
  tag?: string;
  name?: string;
  placeholder?: string;
  labelText?: string;
}

const TAG_FRIENDLY: Record<string, string> = {
  a: 'link', button: 'button', input: 'field', select: 'dropdown',
  textarea: 'text area', img: 'image', form: 'form', nav: 'navigation',
  dialog: 'dialog', details: 'details',
};

/**
 * Generate a human-readable step label from action type + target + DOM context.
 * Pure heuristic — no LLM call by default.
 */
export function generateStepName(
  action: string,
  target: string,
  ctx: DomContext = {},
): string {
  const label = ctx.ariaLabel || ctx.visibleText || ctx.labelText || target;
  const shortLabel = label.length > 40 ? label.slice(0, 37) + '...' : label;
  const kind = TAG_FRIENDLY[ctx.tag || ''] || ctx.role || ctx.tag || 'element';

  switch (action) {
    case 'click': return `Click '${shortLabel}' ${kind}`;
    case 'fill': return `Fill '${ctx.placeholder || ctx.name || shortLabel}' with value`;
    case 'type': return `Type in '${ctx.placeholder || ctx.name || shortLabel}' ${kind}`;
    case 'goto': return `Navigate to ${target}`;
    case 'select': return `Select from '${ctx.name || shortLabel}' dropdown`;
    case 'check': return `Check '${shortLabel}'`;
    case 'uncheck': return `Uncheck '${shortLabel}'`;
    case 'key': return `Press ${target}`;
    case 'scroll': return `Scroll to '${shortLabel}'`;
    case 'hover': return `Hover over '${shortLabel}' ${kind}`;
    case 'focus': return `Focus '${shortLabel}' ${kind}`;
    case 'drag': return `Drag '${shortLabel}'`;
    case 'upload': return `Upload file to '${shortLabel}'`;
    case 'screenshot': return `Screenshot '${shortLabel}'`;
    case 'waitfor': return `Wait for '${shortLabel}'`;
    case 'reload': return 'Reload page';
    case 'back': return 'Navigate back';
    case 'forward': return 'Navigate forward';
    default: return `${action} '${shortLabel}'`;
  }
}

function classifyElementType(el: { tag: string; role: string; type: string }): string {
  if (el.role) return el.role;
  if (el.tag === 'a') return 'link';
  if (el.tag === 'button') return 'button';
  if (el.tag === 'input') return el.type || 'text';
  if (el.tag === 'select') return 'select';
  if (el.tag === 'textarea') return 'textarea';
  return el.tag;
}

function describeElement(el: {
  tag: string; role: string; ariaLabel: string; text: string;
  href: string; type: string; name: string; placeholder: string;
}): string {
  const kind = el.role || el.tag;
  const friendlyKind = kind.charAt(0).toUpperCase() + kind.slice(1);

  if (el.ariaLabel) return `${friendlyKind} labeled "${el.ariaLabel}"`;
  if (el.text && el.text.length <= 40) return `${friendlyKind} "${el.text}"`;
  if (el.tag === 'a' && el.href) {
    try {
      const url = new URL(el.href);
      return `Link to ${url.pathname}`;
    } catch {
      return `Link "${el.text.slice(0, 30)}"`;
    }
  }
  if (el.placeholder) return `${friendlyKind} with placeholder "${el.placeholder}"`;
  if (el.name) return `${friendlyKind} named "${el.name}"`;
  if (el.text) return `${friendlyKind} "${el.text.slice(0, 40)}..."`;
  return friendlyKind;
}
