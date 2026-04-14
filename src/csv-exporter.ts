import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { InspectResult } from './types.js';

export interface CsvOptions {
  delimiter?: string;
  lineEnding?: '\n' | '\r\n';
  header?: boolean;
}

interface ResolvedCsvOptions {
  delimiter: string;
  lineEnding: '\n' | '\r\n';
  header: boolean;
}

type CsvCell = string | number | boolean | null | undefined;

function resolve(opts: CsvOptions | undefined): ResolvedCsvOptions {
  return {
    delimiter: opts?.delimiter ?? ',',
    lineEnding: opts?.lineEnding ?? '\n',
    header: opts?.header !== false,
  };
}

function escapeCell(value: CsvCell, delimiter: string): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const s = String(value);
  const needsQuote =
    s.includes(delimiter) ||
    s.includes('"') ||
    s.includes('\n') ||
    s.includes('\r');
  if (!needsQuote) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function toRow(cells: CsvCell[], delimiter: string): string {
  return cells.map((c) => escapeCell(c, delimiter)).join(delimiter);
}

function serialize(
  headerRow: string[],
  rows: CsvCell[][],
  opts: ResolvedCsvOptions
): string {
  const lines: string[] = [];
  if (opts.header) lines.push(toRow(headerRow, opts.delimiter));
  for (const r of rows) lines.push(toRow(r, opts.delimiter));
  return lines.join(opts.lineEnding) + (lines.length > 0 ? opts.lineEnding : '');
}

function avg(values: number[]): string {
  const valid = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (valid.length === 0) return '';
  const sum = valid.reduce((a, b) => a + b, 0);
  return (sum / valid.length).toFixed(2);
}

function stepLabel(step: unknown): string {
  if (step && typeof step === 'object') {
    const keys = Object.keys(step as Record<string, unknown>);
    if (keys.length > 0) return keys[0];
  }
  return 'step';
}

export function flowsToCsv(result: InspectResult, opts?: CsvOptions): string {
  const o = resolve(opts);
  const header = ['name', 'passed', 'steps', 'durationMs', 'error'];
  const rows: CsvCell[][] = [];
  for (const f of result.flows ?? []) {
    const durationMs = (f.steps ?? []).reduce(
      (sum, s) => sum + (typeof s.durationMs === 'number' ? s.durationMs : 0),
      0
    );
    rows.push([
      f.name,
      f.passed,
      (f.steps ?? []).length,
      durationMs,
      f.error ?? '',
    ]);
  }
  return serialize(header, rows, o);
}

export function a11yToCsv(result: InspectResult, opts?: CsvOptions): string {
  const o = resolve(opts);
  const header = ['page', 'id', 'impact', 'description', 'helpUrl'];
  const rows: CsvCell[][] = [];
  for (const r of result.a11y ?? []) {
    for (const v of r.violations ?? []) {
      rows.push([r.page, v.id, v.impact, v.description, v.helpUrl]);
    }
  }
  return serialize(header, rows, o);
}

export function perfToCsv(result: InspectResult, opts?: CsvOptions): string {
  const o = resolve(opts);
  const header = [
    'page',
    'performance',
    'accessibility',
    'bestPractices',
    'seo',
    'lcp',
    'fcp',
    'cls',
    'tbt',
    'si',
  ];
  const rows: CsvCell[][] = [];
  for (const p of result.perf ?? []) {
    rows.push([
      p.page,
      p.scores?.performance,
      p.scores?.accessibility,
      p.scores?.bestPractices,
      p.scores?.seo,
      p.metrics?.lcp,
      p.metrics?.fcp,
      p.metrics?.cls,
      p.metrics?.tbt,
      p.metrics?.si,
    ]);
  }
  return serialize(header, rows, o);
}

export function visualToCsv(result: InspectResult, opts?: CsvOptions): string {
  const o = resolve(opts);
  const header = ['page', 'viewport', 'diffPixels', 'diffRatio', 'passed'];
  const rows: CsvCell[][] = [];
  for (const v of result.visual ?? []) {
    rows.push([v.page, v.viewport, v.diffPixels, v.diffRatio, v.passed]);
  }
  return serialize(header, rows, o);
}

export function linksToCsv(result: InspectResult, opts?: CsvOptions): string {
  const o = resolve(opts);
  const header = ['page', 'url', 'status', 'ok'];
  const rows: CsvCell[][] = [];
  for (const link of result.links ?? []) {
    for (const broken of link.broken ?? []) {
      const ok =
        typeof broken.status === 'number' &&
        broken.status >= 200 &&
        broken.status < 400;
      rows.push([link.page, broken.url, broken.status, ok]);
    }
  }
  return serialize(header, rows, o);
}

export function consoleErrorsToCsv(
  result: InspectResult,
  opts?: CsvOptions
): string {
  const o = resolve(opts);
  const header = ['page', 'type', 'message'];
  const rows: CsvCell[][] = [];
  for (const c of result.consoleErrors ?? []) {
    for (const issue of c.issues ?? []) {
      rows.push([c.page, issue.type, issue.message]);
    }
  }
  return serialize(header, rows, o);
}

export function summaryToCsv(
  result: InspectResult,
  opts?: CsvOptions
): string {
  const o = resolve(opts);
  const header = [
    'url',
    'startedAt',
    'passed',
    'durationMs',
    'flowsTotal',
    'flowsFailed',
    'a11yCritical',
    'a11ySerious',
    'lcpAvg',
    'clsAvg',
    'visualDiffs',
    'brokenLinks',
    'consoleErrors',
  ];

  const flows = result.flows ?? [];
  const flowsTotal = flows.length;
  const flowsFailed = flows.filter((f) => !f.passed).length;

  let a11yCritical = 0;
  let a11ySerious = 0;
  for (const r of result.a11y ?? []) {
    for (const v of r.violations ?? []) {
      if (v.impact === 'critical') a11yCritical += 1;
      else if (v.impact === 'serious') a11ySerious += 1;
    }
  }

  const perf = result.perf ?? [];
  const lcpAvg = avg(perf.map((p) => p.metrics?.lcp ?? NaN));
  const clsAvg = avg(perf.map((p) => p.metrics?.cls ?? NaN));

  const visualDiffs = (result.visual ?? []).filter(
    (v) => !v.passed || v.diffPixels > 0
  ).length;

  let brokenLinks = 0;
  for (const link of result.links ?? []) {
    brokenLinks += (link.broken ?? []).length;
  }

  let consoleErrorCount = 0;
  for (const c of result.consoleErrors ?? []) {
    consoleErrorCount += c.errorCount ?? 0;
  }

  const row: CsvCell[] = [
    result.url,
    result.startedAt,
    result.passed,
    result.durationMs,
    flowsTotal,
    flowsFailed,
    a11yCritical,
    a11ySerious,
    lcpAvg,
    clsAvg,
    visualDiffs,
    brokenLinks,
    consoleErrorCount,
  ];

  return serialize(header, [row], o);
}

function hasBodyRows(csv: string, opts: ResolvedCsvOptions): boolean {
  if (!csv) return false;
  const parts = csv.split(opts.lineEnding).filter((l) => l.length > 0);
  if (parts.length === 0) return false;
  if (opts.header) return parts.length > 1;
  return parts.length > 0;
}

export async function writeAllCsvs(
  result: InspectResult,
  outDir: string,
  opts?: CsvOptions
): Promise<string[]> {
  const o = resolve(opts);
  await mkdir(outDir, { recursive: true });

  const sections: { name: string; csv: string; always?: boolean }[] = [
    { name: 'flows.csv', csv: flowsToCsv(result, opts) },
    { name: 'a11y.csv', csv: a11yToCsv(result, opts) },
    { name: 'perf.csv', csv: perfToCsv(result, opts) },
    { name: 'visual.csv', csv: visualToCsv(result, opts) },
    { name: 'links.csv', csv: linksToCsv(result, opts) },
    { name: 'console-errors.csv', csv: consoleErrorsToCsv(result, opts) },
    { name: 'summary.csv', csv: summaryToCsv(result, opts), always: true },
  ];

  const written: string[] = [];
  for (const s of sections) {
    const include = s.always === true || hasBodyRows(s.csv, o);
    if (!include) continue;
    const path = join(outDir, s.name);
    await writeFile(path, s.csv, 'utf8');
    written.push(path);
  }
  return written;
}

// internal exports used by tests / adjacent tooling
export const __internal = { escapeCell, toRow, avg, stepLabel, resolve };
