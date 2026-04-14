import type { Page } from 'playwright';

export interface PageObjectOptions {
  className?: string;
  includeForms?: boolean;
  includeRoles?: boolean;
  includeTestIds?: boolean;
  maxElements?: number;
}

export interface PageObjectElement {
  name: string;
  kind: 'button' | 'link' | 'input' | 'heading' | 'textbox' | 'checkbox' | 'radio' | 'select' | 'testid' | 'other';
  locator: string;
  description: string;
}

interface ScanFlags {
  includeForms: boolean;
  includeRoles: boolean;
  includeTestIds: boolean;
  maxElements: number;
}

interface RawScanned {
  kind: PageObjectElement['kind'];
  locator: string;
  description: string;
}

export async function scanPageObject(page: Page, opts: PageObjectOptions = {}): Promise<PageObjectElement[]> {
  const flags: ScanFlags = {
    includeForms: opts.includeForms ?? true,
    includeRoles: opts.includeRoles ?? true,
    includeTestIds: opts.includeTestIds ?? true,
    maxElements: opts.maxElements ?? 40,
  };

  const raw = await page.evaluate(collectElements, flags);
  const seen = new Set<string>();
  const nameCounts = new Map<string, number>();
  const elements: PageObjectElement[] = [];

  for (const item of raw) {
    const dedupKey = `${item.kind}::${item.description.toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const baseName = buildName(item.description, item.kind);
    const count = nameCounts.get(baseName) ?? 0;
    nameCounts.set(baseName, count + 1);
    const finalName = count === 0 ? baseName : `${baseName}${count + 1}`;

    elements.push({
      name: finalName,
      kind: item.kind,
      locator: item.locator,
      description: item.description,
    });

    if (elements.length >= flags.maxElements) break;
  }

  return elements;
}

export function renderPageObjectClass(elements: PageObjectElement[], className: string): string {
  const safeClassName = pascalize(className) || 'GeneratedPage';
  const lines: string[] = [];
  lines.push(`import type { Page, Locator } from 'playwright';`);
  lines.push('');
  lines.push(`export class ${safeClassName} {`);
  lines.push('  constructor(private page: Page) {}');

  for (const el of elements) {
    lines.push('');
    lines.push(`  // ${sanitizeComment(el.description)} (${el.kind})`);
    lines.push(`  get ${el.name}(): Locator {`);
    lines.push(`    return this.page.${el.locator};`);
    lines.push('  }');

    const helpers = renderHelpers(el);
    for (const helper of helpers) {
      lines.push('');
      lines.push(helper);
    }
  }

  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

export async function generatePageObject(page: Page, opts: PageObjectOptions = {}): Promise<string> {
  const elements = await scanPageObject(page, opts);
  const className = opts.className ?? deriveClassNameFromUrl(page.url());
  return renderPageObjectClass(elements, className);
}

function renderHelpers(el: PageObjectElement): string[] {
  const cap = capitalize(el.name);
  const out: string[] = [];
  if (el.kind === 'button' || el.kind === 'link') {
    out.push(`  async click${cap}(): Promise<void> {`);
    out.push(`    await this.${el.name}.click();`);
    out.push('  }');
  } else if (el.kind === 'input' || el.kind === 'textbox') {
    out.push(`  async fill${cap}(value: string): Promise<void> {`);
    out.push(`    await this.${el.name}.fill(value);`);
    out.push('  }');
  } else if (el.kind === 'select') {
    out.push(`  async select${cap}(value: string): Promise<void> {`);
    out.push(`    await this.${el.name}.selectOption(value);`);
    out.push('  }');
  } else if (el.kind === 'checkbox') {
    out.push(`  async check${cap}(): Promise<void> {`);
    out.push(`    await this.${el.name}.check();`);
    out.push('  }');
    out.push(`  async uncheck${cap}(): Promise<void> {`);
    out.push(`    await this.${el.name}.uncheck();`);
    out.push('  }');
  } else if (el.kind === 'radio') {
    out.push(`  async check${cap}(): Promise<void> {`);
    out.push(`    await this.${el.name}.check();`);
    out.push('  }');
  }
  return out;
}

function buildName(description: string, kind: PageObjectElement['kind']): string {
  const cleaned = description
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = cleaned.split(' ').filter((w) => w.length > 0).slice(0, 5);
  if (words.length === 0) {
    return `element${capitalize(kind)}`;
  }
  const first = words[0].toLowerCase();
  const rest = words.slice(1).map((w) => capitalize(w.toLowerCase())).join('');
  const base = first + rest;
  const suffix = kindSuffix(kind);
  if (base.toLowerCase().endsWith(suffix.toLowerCase())) {
    return sanitizeIdentifier(base);
  }
  return sanitizeIdentifier(base + suffix);
}

function kindSuffix(kind: PageObjectElement['kind']): string {
  switch (kind) {
    case 'button':
      return 'Button';
    case 'link':
      return 'Link';
    case 'input':
    case 'textbox':
      return 'Input';
    case 'heading':
      return 'Heading';
    case 'checkbox':
      return 'Checkbox';
    case 'radio':
      return 'Radio';
    case 'select':
      return 'Select';
    case 'testid':
      return 'Element';
    default:
      return 'Element';
  }
}

function sanitizeIdentifier(raw: string): string {
  let s = raw.replace(/[^A-Za-z0-9_]/g, '');
  if (!s) s = 'element';
  if (/^[0-9]/.test(s)) s = 'el' + s;
  return s;
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function pascalize(raw: string): string {
  const parts = raw
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((p) => p.length > 0);
  if (parts.length === 0) return '';
  return parts.map((p) => capitalize(p.toLowerCase())).join('');
}

function sanitizeComment(s: string): string {
  return s.replace(/\r?\n/g, ' ').replace(/\*\//g, '*\\/').slice(0, 120);
}

function deriveClassNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter((p) => p.length > 0);
    const base = segments.length > 0 ? segments[segments.length - 1] : u.hostname.split('.')[0];
    const className = pascalize(base);
    return (className || 'GeneratedPage') + 'Page';
  } catch {
    return 'GeneratedPage';
  }
}

function collectElements(flags: ScanFlags): RawScanned[] {
  const out: RawScanned[] = [];
  const max = flags.maxElements;

  const isVisible = (el: Element): boolean => {
    const node = el as HTMLElement;
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (Number(style.opacity) === 0) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  };

  const textOf = (el: Element): string => {
    const node = el as HTMLElement;
    const aria = node.getAttribute('aria-label') || '';
    if (aria) return aria.trim();
    const t = (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ');
    return t.slice(0, 80);
  };

  const labelFor = (el: HTMLElement): string => {
    const input = el as HTMLInputElement;
    const labels = input.labels;
    if (labels && labels.length > 0) {
      return Array.from(labels)
        .map((l) => (l.textContent || '').trim())
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    const id = input.id;
    if (id) {
      const explicit = document.querySelector(`label[for=${JSON.stringify(id)}]`);
      if (explicit) return (explicit.textContent || '').trim().replace(/\s+/g, ' ');
    }
    return '';
  };

  const headingLevel = (el: Element): number => {
    const m = /^h([1-6])$/i.exec(el.tagName);
    return m ? Number(m[1]) : 0;
  };

  const pushItem = (item: RawScanned): boolean => {
    out.push(item);
    return out.length < max;
  };

  if (flags.includeRoles) {
    const buttons = document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]');
    for (const b of Array.from(buttons)) {
      if (!isVisible(b)) continue;
      const name = textOf(b) || (b as HTMLInputElement).value || '';
      if (!name) continue;
      const locator = `getByRole('button', { name: ${JSON.stringify(name)} })`;
      if (!pushItem({ kind: 'button', locator, description: name })) return out;
    }

    const links = document.querySelectorAll('a[href]');
    for (const a of Array.from(links)) {
      if (!isVisible(a)) continue;
      const name = textOf(a);
      if (!name) continue;
      const locator = `getByRole('link', { name: ${JSON.stringify(name)} })`;
      if (!pushItem({ kind: 'link', locator, description: name })) return out;
    }

    const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
    for (const h of Array.from(headings)) {
      if (!isVisible(h)) continue;
      const name = textOf(h);
      const level = headingLevel(h);
      if (!name || !level) continue;
      const locator = `getByRole('heading', { name: ${JSON.stringify(name)}, level: ${level} })`;
      if (!pushItem({ kind: 'heading', locator, description: name })) return out;
    }
  }

  if (flags.includeForms) {
    const textSelector = 'input[type="text"], input[type="email"], input[type="password"], input[type="search"], input:not([type]), textarea';
    const textInputs = document.querySelectorAll(textSelector);
    for (const input of Array.from(textInputs)) {
      if (!isVisible(input)) continue;
      const el = input as HTMLInputElement;
      const label = labelFor(el);
      const placeholder = el.getAttribute('placeholder') || '';
      const testId = el.getAttribute('data-testid') || '';
      const nameAttr = el.getAttribute('name') || '';
      let locator = '';
      let description = '';
      if (label) {
        locator = `getByLabel(${JSON.stringify(label)})`;
        description = label;
      } else if (placeholder) {
        locator = `getByPlaceholder(${JSON.stringify(placeholder)})`;
        description = placeholder;
      } else if (testId) {
        locator = `getByTestId(${JSON.stringify(testId)})`;
        description = testId;
      } else if (nameAttr) {
        locator = `locator('[name=${cssEscape(nameAttr)}]')`;
        description = nameAttr;
      } else {
        continue;
      }
      const kind: PageObjectElement['kind'] = el.tagName.toLowerCase() === 'textarea' ? 'textbox' : 'input';
      if (!pushItem({ kind, locator, description })) return out;
    }

    const labeledField = (el: HTMLElement, kind: PageObjectElement['kind'], fallbackPrefix: string): RawScanned | null => {
      const label = labelFor(el);
      const testId = el.getAttribute('data-testid') || '';
      const nameAttr = el.getAttribute('name') || '';
      if (label) return { kind, locator: `getByLabel(${JSON.stringify(label)})`, description: label };
      if (testId) return { kind, locator: `getByTestId(${JSON.stringify(testId)})`, description: testId };
      if (nameAttr) return { kind, locator: `locator('${fallbackPrefix}[name=${cssEscape(nameAttr)}]')`, description: nameAttr };
      return null;
    };

    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    for (const cb of Array.from(checkboxes)) {
      if (!isVisible(cb)) continue;
      const hit = labeledField(cb as HTMLElement, 'checkbox', '');
      if (hit && !pushItem(hit)) return out;
    }

    const radios = document.querySelectorAll('input[type="radio"]');
    for (const rd of Array.from(radios)) {
      if (!isVisible(rd)) continue;
      const hit = labeledField(rd as HTMLElement, 'radio', '');
      if (hit && !pushItem(hit)) return out;
    }

    const selects = document.querySelectorAll('select');
    for (const sel of Array.from(selects)) {
      if (!isVisible(sel)) continue;
      const hit = labeledField(sel as HTMLElement, 'select', 'select');
      if (hit && !pushItem(hit)) return out;
    }
  }

  if (flags.includeTestIds) {
    const withTestId = document.querySelectorAll('[data-testid]');
    for (const el of Array.from(withTestId)) {
      if (!isVisible(el)) continue;
      const id = el.getAttribute('data-testid') || '';
      if (!id) continue;
      const locator = `getByTestId(${JSON.stringify(id)})`;
      if (!pushItem({ kind: 'testid', locator, description: id })) return out;
    }
  }

  return out;
}

function cssEscape(value: string): string {
  const safe = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${safe}"`;
}
