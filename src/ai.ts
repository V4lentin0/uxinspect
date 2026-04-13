import type { Page, Locator } from 'playwright';

export interface AIHelperOptions {
  model?: string;
  headless?: boolean;
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

  constructor(opts: AIHelperOptions = {}) {
    this.opts = opts;
  }

  async init(page?: Page): Promise<Page | null> {
    this._page = page ?? null;
    return this._page;
  }

  get page(): Page | null {
    return this._page;
  }

  async act(instruction: string): Promise<boolean> {
    if (!this._page) return false;
    const parsed = parseInstruction(instruction);
    if (!parsed) return false;
    const loc = await resolveLocator(this._page, parsed.target, parsed.verb);
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
  }

  isAvailable(): boolean {
    return this._page !== null;
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
