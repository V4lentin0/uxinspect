import type { Page } from 'playwright';
import type { Flow, Step } from './types.js';

export interface GenerateOptions {
  maxClicks?: number;
  maxFills?: number;
  captureScreenshots?: boolean;
  flowName?: string;
  preferRoles?: boolean;
}

export interface GeneratedFlow {
  flow: Flow;
  reasoning: string[];
  coverage: {
    buttonsFound: number;
    linksFound: number;
    inputsFound: number;
    usedSelectors: string[];
  };
}

export interface PageElementInfo {
  kind: 'button' | 'link' | 'input' | 'textarea' | 'select';
  accessibleName: string;
  role?: string;
  bestSelector: string;
  action?: 'submit' | 'navigate' | 'toggle' | 'unknown';
}

interface RawElement {
  tag: string;
  type: string;
  ariaLabel: string;
  ariaLabelledByText: string;
  labelText: string;
  innerText: string;
  placeholder: string;
  name: string;
  id: string;
  testId: string;
  href: string;
  isSubmit: boolean;
  isToggle: boolean;
  isPassword: boolean;
  isHidden: boolean;
  isDisabled: boolean;
  nthOfType: number;
  inputMode: string;
}

export async function scanInteractions(page: Page): Promise<PageElementInfo[]> {
  const raw = await page.evaluate(collectRawElements);
  const pageOrigin = new URL(page.url()).origin;
  const pagePath = new URL(page.url()).pathname;
  const result: PageElementInfo[] = [];
  for (const el of raw) {
    if (el.isHidden || el.isDisabled) continue;
    const kind = classifyKind(el);
    if (!kind) continue;
    const accessibleName = pickAccessibleName(el);
    const role = pickRole(el, kind);
    const bestSelector = pickBestSelector(el, kind, accessibleName, role);
    const action = pickAction(el, kind, pageOrigin, pagePath);
    result.push({ kind, accessibleName, role, bestSelector, action });
  }
  return result;
}

export async function generateFlow(page: Page, opts: GenerateOptions = {}): Promise<GeneratedFlow> {
  const maxClicks = opts.maxClicks ?? 5;
  const maxFills = opts.maxFills ?? 3;
  const captureScreenshots = opts.captureScreenshots ?? true;
  const flowName = opts.flowName ?? 'generated-flow';
  const preferRoles = opts.preferRoles ?? true;

  const elements = await scanInteractions(page);
  const reasoning: string[] = [];
  const usedSelectors: string[] = [];
  const steps: Step[] = [];

  const startUrl = page.url();
  steps.push({ goto: startUrl });
  reasoning.push(`added goto ${startUrl} as entry step`);
  steps.push({ waitFor: 'body' });
  reasoning.push('added waitFor body to ensure DOM ready');

  const fillable = elements.filter((e) => (e.kind === 'input' || e.kind === 'textarea') && !isPasswordSelector(e));
  const fillTargets = fillable.slice(0, maxFills);
  for (const el of fillTargets) {
    const text = suggestText(el);
    const selector = preferRoles ? el.bestSelector : downgradeSelector(el.bestSelector);
    steps.push({ fill: { selector, text } });
    usedSelectors.push(selector);
    reasoning.push(`added fill on ${selector} with sample text "${text}" because kind=${el.kind}`);
  }

  const clickable = elements.filter((e) => e.kind === 'button' || e.kind === 'link');
  const ranked = clickable.slice().sort(rankClickables);
  const clickTargets = ranked.slice(0, maxClicks);
  let stepCounter = 0;
  for (const el of clickTargets) {
    const selector = preferRoles ? el.bestSelector : downgradeSelector(el.bestSelector);
    steps.push({ click: selector });
    usedSelectors.push(selector);
    reasoning.push(`added click on ${selector} because action=${el.action ?? 'unknown'}`);
    if (el.action === 'navigate') {
      steps.push({ waitFor: 'body' });
      reasoning.push('added waitFor body after navigate click');
    }
    if (captureScreenshots) {
      stepCounter += 1;
      const shot = `step-${stepCounter}`;
      steps.push({ screenshot: shot });
      reasoning.push(`added screenshot ${shot} after click`);
    }
  }

  const flow: Flow = { name: flowName, steps };
  const buttonsFound = elements.filter((e) => e.kind === 'button').length;
  const linksFound = elements.filter((e) => e.kind === 'link').length;
  const inputsFound = elements.filter((e) => e.kind === 'input' || e.kind === 'textarea').length;
  return { flow, reasoning, coverage: { buttonsFound, linksFound, inputsFound, usedSelectors } };
}

export function flowToSnippet(flow: Flow): string {
  const lines: string[] = [];
  lines.push('export const flow = {');
  lines.push(`  name: ${jsonString(flow.name)},`);
  lines.push('  steps: [');
  for (const step of flow.steps) {
    lines.push(`    ${serializeStep(step)},`);
  }
  lines.push('  ]');
  lines.push('};');
  return lines.join('\n');
}

function serializeStep(step: Step): string {
  if ('goto' in step) return `{ goto: ${jsonString(step.goto)} }`;
  if ('click' in step) return `{ click: ${jsonString(step.click)} }`;
  if ('fill' in step) return `{ fill: { selector: ${jsonString(step.fill.selector)}, text: ${jsonString(step.fill.text)} } }`;
  if ('waitFor' in step) return `{ waitFor: ${jsonString(step.waitFor)} }`;
  if ('screenshot' in step) return `{ screenshot: ${jsonString(step.screenshot)} }`;
  if ('hover' in step) return `{ hover: ${jsonString(step.hover)} }`;
  return '{}';
}

function jsonString(v: string): string {
  return JSON.stringify(v);
}

function rankClickables(a: PageElementInfo, b: PageElementInfo): number {
  const order: Record<string, number> = { navigate: 0, submit: 1, unknown: 2, toggle: 3 };
  const av = order[a.action ?? 'unknown'] ?? 2;
  const bv = order[b.action ?? 'unknown'] ?? 2;
  return av - bv;
}

function suggestText(el: PageElementInfo): string {
  const hint = (el.accessibleName + ' ' + (el.bestSelector || '')).toLowerCase();
  if (/password/.test(hint)) return 'uxinspect-sample-pass';
  if (/email|e-mail/.test(hint)) return 'user@example.com';
  if (/phone|tel|mobile/.test(hint)) return '+15551234567';
  if (/search|query/.test(hint)) return 'hello';
  if (/url|website|link/.test(hint)) return 'https://example.com';
  if (/name/.test(hint)) return 'Ada Lovelace';
  if (/age|number|qty|quantity|count|amount|price/.test(hint)) return '42';
  return 'uxinspect sample';
}

function isPasswordSelector(el: PageElementInfo): boolean {
  return /password/i.test(el.accessibleName) || /type="password"/i.test(el.bestSelector);
}

function downgradeSelector(sel: string): string {
  return sel;
}

function classifyKind(el: RawElement): PageElementInfo['kind'] | null {
  const tag = el.tag.toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a') return 'link';
  if (tag === 'textarea') return 'textarea';
  if (tag === 'select') return 'select';
  if (tag === 'input') {
    const t = (el.type || 'text').toLowerCase();
    if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
    if (t === 'checkbox' || t === 'radio') return 'button';
    return 'input';
  }
  return null;
}

function pickAccessibleName(el: RawElement): string {
  const candidates = [
    el.ariaLabel,
    el.ariaLabelledByText,
    el.labelText,
    el.innerText,
    el.placeholder,
    el.name,
    el.id,
  ];
  for (const c of candidates) {
    const trimmed = (c || '').trim().replace(/\s+/g, ' ');
    if (trimmed) return trimmed.slice(0, 80);
  }
  return '';
}

function pickRole(el: RawElement, kind: PageElementInfo['kind']): string | undefined {
  const tag = el.tag.toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a') return 'link';
  if (tag === 'input') {
    const t = (el.type || 'text').toLowerCase();
    if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio';
    return 'textbox';
  }
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return 'combobox';
  return kind;
}

function pickBestSelector(el: RawElement, kind: PageElementInfo['kind'], name: string, role: string | undefined): string {
  if (role && name) {
    return `role=${role}[name=${quoteForRole(name)}]`;
  }
  if (el.ariaLabel) {
    return `[aria-label=${quoteForAttr(el.ariaLabel)}]`;
  }
  if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) {
    return `#${el.id}`;
  }
  if (el.testId) {
    return `[data-testid=${quoteForAttr(el.testId)}]`;
  }
  const tag = el.tag.toLowerCase();
  void kind;
  return `${tag}:nth-of-type(${el.nthOfType})`;
}

function pickAction(
  el: RawElement,
  kind: PageElementInfo['kind'],
  pageOrigin: string,
  pagePath: string,
): PageElementInfo['action'] {
  if (el.isSubmit) return 'submit';
  if (el.isToggle) return 'toggle';
  if (kind === 'link' && el.href) {
    try {
      const target = new URL(el.href, pageOrigin + pagePath);
      if (target.origin !== pageOrigin || target.pathname !== pagePath) return 'navigate';
    } catch {
      return 'unknown';
    }
  }
  return 'unknown';
}

function quoteForRole(name: string): string {
  const safe = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${safe}"`;
}

function quoteForAttr(value: string): string {
  const safe = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${safe}"`;
}

function collectRawElements(): RawElement[] {
  const sel = 'button, a[href], input:not([type="hidden"]):not([disabled]), textarea, select';
  const nodes = Array.from(document.querySelectorAll(sel));
  const counts = new Map<string, number>();
  const out: RawElement[] = [];
  for (const node of nodes) {
    const tag = node.tagName.toLowerCase();
    const key = tag;
    const idx = (counts.get(key) ?? 0) + 1;
    counts.set(key, idx);
    const el = node as HTMLElement & {
      type?: string;
      placeholder?: string;
      name?: string;
      labels?: NodeListOf<HTMLLabelElement> | null;
      href?: string;
      form?: HTMLFormElement | null;
      checked?: boolean;
      inputMode?: string;
    };
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const isHidden =
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number(style.opacity) === 0 ||
      (rect.width === 0 && rect.height === 0);
    const ariaLabel = el.getAttribute('aria-label') || '';
    const labelledBy = el.getAttribute('aria-labelledby') || '';
    let labelledByText = '';
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter((n): n is HTMLElement => Boolean(n))
        .map((n) => n.textContent || '');
      labelledByText = parts.join(' ').trim();
    }
    let labelText = '';
    const labels = el.labels;
    if (labels && labels.length > 0) {
      labelText = Array.from(labels)
        .map((l) => l.textContent || '')
        .join(' ')
        .trim();
    }
    const type = (el.type || el.getAttribute('type') || '').toString();
    const isSubmit =
      (tag === 'button' && (el.getAttribute('type') || 'submit').toLowerCase() === 'submit' && Boolean(el.form)) ||
      (tag === 'input' && type.toLowerCase() === 'submit');
    const isToggle = tag === 'input' && (type.toLowerCase() === 'checkbox' || type.toLowerCase() === 'radio');
    const isPassword = tag === 'input' && type.toLowerCase() === 'password';
    const isDisabled = el.hasAttribute('disabled');
    out.push({
      tag,
      type,
      ariaLabel,
      ariaLabelledByText: labelledByText,
      labelText,
      innerText: (el.innerText || el.textContent || '').trim(),
      placeholder: el.placeholder || el.getAttribute('placeholder') || '',
      name: el.getAttribute('name') || '',
      id: el.id || '',
      testId: el.getAttribute('data-testid') || '',
      href: el.getAttribute('href') || '',
      isSubmit,
      isToggle,
      isPassword,
      isHidden,
      isDisabled,
      nthOfType: idx,
      inputMode: el.inputMode || el.getAttribute('inputmode') || '',
    });
  }
  return out;
}
