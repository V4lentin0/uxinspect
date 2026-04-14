import { readFile } from 'node:fs/promises';
import type { Flow, Step } from './types.js';

export interface ConversionWarning {
  line: number;
  snippet: string;
  reason: string;
}

export interface ConversionResult {
  flow: Flow;
  warnings: ConversionWarning[];
  unconverted: string[];
  coverage: number;
}

export interface ConvertOptions {
  flowName?: string;
}

interface JoinedLine {
  line: number;
  text: string;
}

interface ConvertedOne {
  step?: Step;
  warning?: string;
}

interface LocatorDesc {
  selector: string;
  reason?: string;
}

const IGNORE_PREFIXES = [
  'import ', 'import{', 'const ', 'let ', 'var ', 'export ',
  'test(', 'test.', 'test ', 'describe(', 'describe.', 'it(', 'it.',
  'beforeAll', 'beforeEach', 'afterAll', 'afterEach',
  '//', '/*', '*', '*/', '}', '{', ');', '})',
];

function shouldIgnoreLine(t: string): boolean {
  if (t.length === 0) return true;
  for (const p of IGNORE_PREFIXES) if (t.startsWith(p)) return true;
  return false;
}

function joinChainedLines(source: string): JoinedLine[] {
  const rawLines = source.split(/\r?\n/);
  const out: JoinedLine[] = [];
  let buf = '';
  let startLine = 0;
  let paren = 0, brace = 0;
  let inString: string | null = null;
  let escape = false;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const trimmed = line.trim();
    if (buf.length === 0) {
      if (shouldIgnoreLine(trimmed)) continue;
      startLine = i + 1;
    }
    buf = buf.length === 0 ? line : buf + '\n' + line;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (escape) { escape = false; continue; }
      if (inString) {
        if (ch === '\\') { escape = true; continue; }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
      if (ch === '(') paren++;
      else if (ch === ')') paren--;
      else if (ch === '{') brace++;
      else if (ch === '}') brace--;
    }
    const end = buf.trimEnd();
    const endsStmt = end.endsWith(';') || end.endsWith(')');
    if (paren <= 0 && brace <= 0 && inString === null && endsStmt) {
      out.push({ line: startLine, text: buf.trim() });
      buf = ''; paren = 0; brace = 0;
    }
  }
  if (buf.trim().length > 0) out.push({ line: startLine, text: buf.trim() });
  return out;
}

function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length < 2) return s;
  const f = s[0], l = s[s.length - 1];
  if ((f === '"' || f === "'" || f === '`') && f === l) {
    return s.slice(1, -1)
      .replace(/\\n/g, '\n').replace(/\\t/g, '\t')
      .replace(/\\'/g, "'").replace(/\\"/g, '"')
      .replace(/\\`/g, '`').replace(/\\\\/g, '\\');
  }
  return s;
}

function splitTopLevel(inside: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let escape = false;
  let buf = '';
  for (let i = 0; i < inside.length; i++) {
    const ch = inside[i];
    if (escape) { buf += ch; escape = false; continue; }
    if (inString) {
      buf += ch;
      if (ch === '\\') escape = true;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; buf += ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    if (ch === sep && depth === 0) {
      if (buf.trim().length > 0 || sep === ',') out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) out.push(buf.trim());
  return out;
}

function extractArgs(inside: string): string[] {
  return splitTopLevel(inside, ',');
}

function splitChain(chain: string): string[] {
  return splitTopLevel(chain, '.');
}

function parseOptionsObject(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const t = raw.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return out;
  const parts = extractArgs(t.slice(1, -1));
  for (const p of parts) {
    const colon = p.indexOf(':');
    if (colon < 0) continue;
    const key = p.slice(0, colon).trim().replace(/^['"`]|['"`]$/g, '');
    out[key] = unquote(p.slice(colon + 1).trim());
  }
  return out;
}

function matchCall(src: string, name: string): string | null {
  const re = new RegExp(`^${name}\\((.*)\\)$`, 's');
  const m = src.match(re);
  return m ? m[1] : null;
}

function buildLocator(chain: string): LocatorDesc | null {
  const calls = splitChain(chain);
  if (calls.length === 0) return null;
  const first = calls[0];
  let sel: string | null = null;
  let reason: string | undefined;

  const roleInside = matchCall(first, 'getByRole');
  if (roleInside !== null) {
    const args = extractArgs(roleInside);
    const role = unquote(args[0] ?? '');
    const opts = args[1] ? parseOptionsObject(args[1]) : {};
    sel = opts.name ? `role=${role}[name="${opts.name}"]` : `role=${role}`;
  }
  const labelInside = matchCall(first, 'getByLabel');
  if (labelInside !== null) sel = `[aria-label="${unquote(extractArgs(labelInside)[0] ?? '')}"]`;
  const phInside = matchCall(first, 'getByPlaceholder');
  if (phInside !== null) sel = `[placeholder="${unquote(extractArgs(phInside)[0] ?? '')}"]`;
  const textInside = matchCall(first, 'getByText');
  if (textInside !== null) sel = `text=${unquote(extractArgs(textInside)[0] ?? '')}`;
  const titleInside = matchCall(first, 'getByTitle');
  if (titleInside !== null) sel = `[title="${unquote(extractArgs(titleInside)[0] ?? '')}"]`;
  const altInside = matchCall(first, 'getByAltText');
  if (altInside !== null) sel = `[alt="${unquote(extractArgs(altInside)[0] ?? '')}"]`;
  const tidInside = matchCall(first, 'getByTestId');
  if (tidInside !== null) sel = `[data-testid="${unquote(extractArgs(tidInside)[0] ?? '')}"]`;
  const locInside = matchCall(first, 'locator');
  if (locInside !== null) sel = unquote(extractArgs(locInside)[0] ?? '');

  if (sel === null) return null;

  for (let i = 1; i < calls.length; i++) {
    const sub = calls[i];
    if (sub === 'first()') sel = `${sel} >> nth=0`;
    else if (sub === 'last()') sel = `${sel} >> nth=-1`;
    else {
      const nth = sub.match(/^nth\((\d+)\)$/);
      if (nth) sel = `${sel} >> nth=${nth[1]}`;
      else reason = `locator modifier .${sub} approximated`;
    }
  }
  return { selector: sel, reason };
}

function findLastActionDot(rest: string): number {
  let depth = 0;
  let inString: string | null = null;
  let escape = false;
  let lastDot = -1;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    if (ch === '.' && depth === 0) lastDot = i;
  }
  return lastDot;
}

function stepWithWarn(step: Step, reason: string | undefined): ConvertedOne {
  return reason ? { step, warning: reason } : { step };
}

function convertDirectPageCall(rest: string): ConvertedOne | null {
  const ga = (n: string): string[] | null => {
    const m = matchCall(rest, n);
    return m === null ? null : extractArgs(m);
  };
  let a = ga('goto'); if (a) return { step: { goto: unquote(a[0] ?? '') } };
  if (matchCall(rest, 'waitForURL') !== null) return { step: { waitFor: 'body' }, warning: 'waitForURL approximated as waitFor body' };
  a = ga('waitForResponse'); if (a) return { step: { waitForResponse: unquote(a[0] ?? '') } };
  a = ga('waitForRequest'); if (a) return { step: { waitForRequest: unquote(a[0] ?? '') } };
  a = ga('waitForSelector'); if (a) return { step: { waitFor: unquote(a[0] ?? '') } };
  a = ga('waitForTimeout'); if (a) return { step: { sleep: parseInt(a[0] ?? '0', 10) } };
  if (/^reload\(.*\)$/s.test(rest)) return { step: { reload: true } };
  if (/^goBack\(.*\)$/s.test(rest)) return { step: { back: true } };
  if (/^goForward\(.*\)$/s.test(rest)) return { step: { forward: true } };
  a = ga('keyboard\\.press'); if (a) return { step: { key: unquote(a[0] ?? '') } };
  a = ga('keyboard\\.type'); if (a) return { step: { type: { selector: 'body', text: unquote(a[0] ?? '') } } };
  a = ga('click'); if (a) return { step: { click: unquote(a[0] ?? '') } };
  a = ga('fill'); if (a) return { step: { fill: { selector: unquote(a[0] ?? ''), text: unquote(a[1] ?? '') } } };
  a = ga('type'); if (a) return { step: { type: { selector: unquote(a[0] ?? ''), text: unquote(a[1] ?? '') } } };
  a = ga('hover'); if (a) return { step: { hover: unquote(a[0] ?? '') } };
  a = ga('check'); if (a) return { step: { check: unquote(a[0] ?? '') } };
  a = ga('uncheck'); if (a) return { step: { uncheck: unquote(a[0] ?? '') } };
  a = ga('selectOption'); if (a) return { step: { select: { selector: unquote(a[0] ?? ''), value: unquote(a[1] ?? '') } } };
  a = ga('focus'); if (a) return { step: { focus: unquote(a[0] ?? '') } };
  a = ga('screenshot');
  if (a) {
    const opts = a[0] ? parseOptionsObject(a[0]) : {};
    return { step: { screenshot: opts.path ?? 'screenshot.png' } };
  }
  return null;
}

function convertTailedCall(tail: string, reason: string | undefined, sel: string): ConvertedOne | null {
  const ga = (n: string): string[] | null => {
    const m = matchCall(tail, n);
    return m === null ? null : extractArgs(m);
  };
  if (/^click\(.*\)$/s.test(tail)) return stepWithWarn({ click: sel }, reason);
  if (/^dblclick\(.*\)$/s.test(tail)) return stepWithWarn({ click: sel }, 'dblclick approximated as click');
  let a = ga('fill'); if (a) return stepWithWarn({ fill: { selector: sel, text: unquote(a[0] ?? '') } }, reason);
  a = ga('type'); if (a) return stepWithWarn({ type: { selector: sel, text: unquote(a[0] ?? '') } }, reason);
  a = ga('press'); if (a) return stepWithWarn({ key: unquote(a[0] ?? '') }, reason);
  if (/^hover\(.*\)$/s.test(tail)) return stepWithWarn({ hover: sel }, reason);
  if (/^check\(.*\)$/s.test(tail)) return stepWithWarn({ check: sel }, reason);
  if (/^uncheck\(.*\)$/s.test(tail)) return stepWithWarn({ uncheck: sel }, reason);
  if (/^focus\(.*\)$/s.test(tail)) return stepWithWarn({ focus: sel }, reason);
  if (/^blur\(.*\)$/s.test(tail)) return stepWithWarn({ blur: sel }, reason);
  a = ga('selectOption'); if (a) return stepWithWarn({ select: { selector: sel, value: unquote(a[0] ?? '') } }, reason);
  if (/^scrollIntoViewIfNeeded\(.*\)$/s.test(tail)) return stepWithWarn({ scroll: { selector: sel } }, reason);
  if (/^waitFor\(.*\)$/s.test(tail)) return stepWithWarn({ waitFor: sel }, reason);
  return null;
}

function convertStatement(stmt: string): ConvertedOne {
  let text = stmt.replace(/;\s*$/, '').trim();
  if (text.startsWith('await ')) text = text.slice(6).trim();

  if (text.startsWith('expect(') || text.startsWith('expect.')) {
    return { warning: 'assertion dropped — use uxinspect checks for assertions' };
  }

  const pageMatch = text.match(/^page\.(.*)$/s);
  if (!pageMatch) return { warning: 'non-page call ignored' };
  const rest = pageMatch[1];

  const direct = convertDirectPageCall(rest);
  if (direct) return direct;

  const lastDot = findLastActionDot(rest);
  if (lastDot < 0) return { warning: `unsupported page call: ${rest.slice(0, 60)}` };
  const chain = rest.slice(0, lastDot);
  const tail = rest.slice(lastDot + 1);

  const loc = buildLocator(chain);
  if (!loc) return { warning: `unsupported locator chain: ${chain.slice(0, 60)}` };

  const tailed = convertTailedCall(tail, loc.reason, loc.selector);
  if (tailed) return tailed;
  return { warning: `unsupported action .${tail.slice(0, 40)}` };
}

export function convertCodegen(source: string, opts?: ConvertOptions): ConversionResult {
  const joined = joinChainedLines(source);
  const steps: Step[] = [];
  const warnings: ConversionWarning[] = [];
  const unconverted: string[] = [];

  for (const j of joined) {
    const result = convertStatement(j.text);
    if (result.step) {
      steps.push(result.step);
      if (result.warning) warnings.push({ line: j.line, snippet: j.text, reason: result.warning });
    } else {
      unconverted.push(j.text);
      warnings.push({ line: j.line, snippet: j.text, reason: result.warning ?? 'unconverted' });
    }
  }

  const total = steps.length + unconverted.length;
  const coverage = total === 0 ? 1 : steps.length / total;

  return {
    flow: { name: opts?.flowName ?? 'imported-flow', steps },
    warnings,
    unconverted,
    coverage,
  };
}

export async function convertCodegenFile(inPath: string, opts?: ConvertOptions): Promise<ConversionResult> {
  const src = await readFile(inPath, 'utf8');
  return convertCodegen(src, opts);
}

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function stepToPlaywright(step: Step): string {
  if ('goto' in step) return `  await page.goto('${esc(step.goto)}');`;
  if ('click' in step) return `  await page.click('${esc(step.click)}');`;
  if ('fill' in step) return `  await page.fill('${esc(step.fill.selector)}', '${esc(step.fill.text)}');`;
  if ('type' in step) return `  await page.type('${esc(step.type.selector)}', '${esc(step.type.text)}');`;
  if ('hover' in step) return `  await page.hover('${esc(step.hover)}');`;
  if ('check' in step) return `  await page.check('${esc(step.check)}');`;
  if ('uncheck' in step) return `  await page.uncheck('${esc(step.uncheck)}');`;
  if ('focus' in step) return `  await page.focus('${esc(step.focus)}');`;
  if ('blur' in step) return `  await page.locator('${esc(step.blur)}').blur();`;
  if ('select' in step) {
    const v = Array.isArray(step.select.value) ? JSON.stringify(step.select.value) : `'${esc(step.select.value)}'`;
    return `  await page.selectOption('${esc(step.select.selector)}', ${v});`;
  }
  if ('key' in step) return `  await page.keyboard.press('${esc(step.key)}');`;
  if ('waitFor' in step) return `  await page.waitForSelector('${esc(step.waitFor)}');`;
  if ('sleep' in step) return `  await page.waitForTimeout(${step.sleep});`;
  if ('reload' in step) return `  await page.reload();`;
  if ('back' in step) return `  await page.goBack();`;
  if ('forward' in step) return `  await page.goForward();`;
  if ('screenshot' in step) return `  await page.screenshot({ path: '${esc(step.screenshot)}' });`;
  if ('scroll' in step) {
    if (step.scroll.selector) return `  await page.locator('${esc(step.scroll.selector)}').scrollIntoViewIfNeeded();`;
    return `  await page.evaluate(() => window.scrollTo(${step.scroll.x ?? 0}, ${step.scroll.y ?? 0}));`;
  }
  if ('waitForResponse' in step) {
    const url = typeof step.waitForResponse === 'string' ? step.waitForResponse : step.waitForResponse.url;
    return `  await page.waitForResponse('${esc(url)}');`;
  }
  if ('waitForRequest' in step) return `  await page.waitForRequest('${esc(step.waitForRequest)}');`;
  return `  // unsupported step: ${JSON.stringify(step)}`;
}

export function flowToPlaywrightSnippet(flow: Flow): string {
  const lines: string[] = [];
  lines.push(`import { test } from '@playwright/test';`);
  lines.push('');
  lines.push(`test('${esc(flow.name)}', async ({ page }) => {`);
  for (const step of flow.steps) lines.push(stepToPlaywright(step));
  lines.push('});');
  return lines.join('\n');
}
