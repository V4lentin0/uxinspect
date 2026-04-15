import type { Page, Locator } from 'playwright';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface AIHelperOptions {
  model?: string;
  headless?: boolean;
  cachePath?: string;
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

export interface CachedLocator {
  strategy: string;
  value: string;
  verb: string;
  /** Bump each time self-heal rewrites this entry (P2 #26). */
  heals?: number;
  /** Timestamp (ms) of most recent heal. */
  lastHealAt?: number;
}

type LocatorCache = Record<string, CachedLocator>;

type Verb = 'click' | 'type' | 'fill' | 'check' | 'uncheck' | 'select' | 'hover' | 'press';

interface ParsedInstruction {
  verb: Verb;
  target: string;
  value?: string;
}

export class AIHelper {
  private _page: Page | null = null;
  private opts: AIHelperOptions;
  private cache: LocatorCache = {};
  private cacheLoaded = false;
  private healEvents: SelfHealEvent[] = [];
  /** Instruction → true while a self-heal is running. Prevents recursive heal attempts. */
  private healing = new Set<string>();

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

    const cached = this.cache[instruction];
    let loc: Locator | null = null;
    let cachedFailed = false;
    let cacheSelector = '';

    if (cached) {
      cacheSelector = cachedToString(cached);
      loc = locatorFromCache(this._page, cached);
      if (loc && !(await loc.count().catch(() => 0))) {
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
          this.updateCacheForHeal(instruction, parsed.verb, 'reresolve', newSelector);
        } else {
          await this.rememberLocator(instruction, loc, parsed.verb);
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
        this.updateCacheForHeal(instruction, parsed.verb, result.strategy, result.newSelector);
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
    instruction: string,
    verb: string,
    _strategy: HealStrategy,
    newSelector: string,
  ): void {
    const payload = selectorToCacheEntry(newSelector, verb);
    if (!payload) return;
    const prev = this.cache[instruction];
    const heals = (prev?.heals ?? 0) + 1;
    this.cache[instruction] = { ...payload, heals, lastHealAt: Date.now() };
    // Best-effort: also update a co-located P2 #25 locator-cache module if
    // one is wired up. Absent module = silently skip.
    void tryUpdateExternalCache(instruction, this.cache[instruction]!);
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

  private async rememberLocator(instruction: string, loc: Locator, verb: string): Promise<void> {
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
      let strategy = 'text';
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
      // Preserve heals counter across remembers.
      const prev = this.cache[instruction];
      this.cache[instruction] = {
        strategy,
        value,
        verb,
        heals: prev?.heals,
        lastHealAt: prev?.lastHealAt,
      };
    } catch {
      /* ignore */
    }
  }
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
    if (c.strategy === 'text') return page.getByText(c.value, { exact: false }).first();
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

function cachedToString(c: CachedLocator): string {
  return `${c.strategy}=${c.value}`;
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

/**
 * Optional hook into a standalone `locator-cache` module when present
 * (P2 #25 lands on its own branch). Absent module = silently skip.
 */
async function tryUpdateExternalCache(
  instruction: string,
  entry: CachedLocator,
): Promise<void> {
  try {
    // Dynamic import via variable prevents TS from resolving at compile time —
    // P2 #25's `locator-cache` module may not exist until it merges.
    const modulePath = './locator-cache.js';
    const mod: any = await import(/* @vite-ignore */ modulePath).catch(() => null);
    if (!mod) return;
    if (typeof mod.updateCache === 'function') {
      await mod.updateCache(instruction, entry);
    } else if (typeof mod.default?.update === 'function') {
      await mod.default.update(instruction, entry);
    }
  } catch {
    /* defensive: cache module missing or incompatible — heal path still works. */
  }
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
