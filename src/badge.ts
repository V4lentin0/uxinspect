import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { InspectResult, A11yResult, PerfResult, VisualResult } from './types.js';

export type BadgeColor = '#10B981' | '#EF4444' | '#F59E0B' | '#3B82F6' | '#6B7280';

export interface BadgeOptions {
  label?: string;
  value?: string;
  color?: BadgeColor | string;
}

const COLOR_PASS: BadgeColor = '#10B981';
const COLOR_FAIL: BadgeColor = '#EF4444';
const COLOR_WARN: BadgeColor = '#F59E0B';
const COLOR_INFO: BadgeColor = '#3B82F6';
const COLOR_UNKNOWN: BadgeColor = '#6B7280';

const LEFT_BG = '#555';
const CHAR_WIDTH_PX = 6;
const SEGMENT_PADDING_PX = 20;
const BADGE_HEIGHT = 20;

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function segmentWidth(text: string): number {
  return Math.max(text.length * CHAR_WIDTH_PX + SEGMENT_PADDING_PX, SEGMENT_PADDING_PX + CHAR_WIDTH_PX);
}

export function renderBadge(label: string, value: string, color: string): string {
  const safeLabel = escapeXml(label);
  const safeValue = escapeXml(value);
  const safeColor = escapeXml(color);

  const leftWidth = segmentWidth(label);
  const rightWidth = segmentWidth(value);
  const totalWidth = leftWidth + rightWidth;
  const leftCenter = leftWidth / 2;
  const rightCenter = leftWidth + rightWidth / 2;
  const title = `${safeLabel}: ${safeValue}`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${BADGE_HEIGHT}" ` +
    `role="img" aria-label="${title}">` +
    `<title>${title}</title>` +
    `<linearGradient id="smooth" x2="0" y2="100%">` +
    `<stop offset="0" stop-color="#fff" stop-opacity=".1"/>` +
    `<stop offset="1" stop-opacity=".1"/>` +
    `</linearGradient>` +
    `<clipPath id="round"><rect width="${totalWidth}" height="${BADGE_HEIGHT}" rx="3" fill="#fff"/></clipPath>` +
    `<g clip-path="url(#round)">` +
    `<rect width="${leftWidth}" height="${BADGE_HEIGHT}" fill="${LEFT_BG}"/>` +
    `<rect x="${leftWidth}" width="${rightWidth}" height="${BADGE_HEIGHT}" fill="${safeColor}"/>` +
    `<rect width="${totalWidth}" height="${BADGE_HEIGHT}" fill="url(#smooth)"/>` +
    `</g>` +
    `<g fill="#fff" text-anchor="middle" ` +
    `font-family="DejaVu Sans,Verdana,Geneva,sans-serif" ` +
    `font-size="11" font-weight="bold" ` +
    `text-rendering="geometricPrecision">` +
    `<text x="${leftCenter}" y="15" fill="#010101" fill-opacity=".3">${safeLabel}</text>` +
    `<text x="${leftCenter}" y="14">${safeLabel}</text>` +
    `<text x="${rightCenter}" y="15" fill="#010101" fill-opacity=".3">${safeValue}</text>` +
    `<text x="${rightCenter}" y="14">${safeValue}</text>` +
    `</g>` +
    `</svg>`
  );
}

function resolve(label: string, value: string, color: string, opts?: BadgeOptions): string {
  const l = opts?.label ?? label;
  const v = opts?.value ?? value;
  const c = opts?.color ?? color;
  return renderBadge(l, v, c);
}

export function statusBadge(result: InspectResult, opts?: BadgeOptions): string {
  const passed = result.passed === true;
  const value = passed ? 'passing' : 'failing';
  const color = passed ? COLOR_PASS : COLOR_FAIL;
  return resolve('uxinspect', value, color, opts);
}

function countCriticalA11y(a11y: A11yResult[] | undefined): number {
  if (!a11y || a11y.length === 0) return 0;
  let total = 0;
  for (const page of a11y) {
    for (const v of page.violations) {
      if (v.impact === 'critical') total++;
    }
  }
  return total;
}

export function a11yBadge(result: InspectResult, opts?: BadgeOptions): string {
  const a11y = result.a11y;
  if (!a11y || a11y.length === 0) {
    return resolve('a11y', 'n/a', COLOR_UNKNOWN, opts);
  }
  const critical = countCriticalA11y(a11y);
  const value = `${critical} critical`;
  let color: BadgeColor;
  if (critical === 0) color = COLOR_PASS;
  else if (critical <= 2) color = COLOR_WARN;
  else color = COLOR_FAIL;
  return resolve('a11y', value, color, opts);
}

function averagePerfScore(perf: PerfResult[]): number {
  const sum = perf.reduce((acc, p) => acc + (p.scores.performance ?? 0), 0);
  return Math.round(sum / perf.length);
}

export function perfBadge(result: InspectResult, opts?: BadgeOptions): string {
  const perf = result.perf;
  if (!perf || perf.length === 0) {
    return resolve('perf', 'n/a', COLOR_UNKNOWN, opts);
  }
  const score = averagePerfScore(perf);
  let color: BadgeColor;
  if (score >= 90) color = COLOR_PASS;
  else if (score >= 70) color = COLOR_WARN;
  else color = COLOR_FAIL;
  return resolve('perf', String(score), color, opts);
}

function averageLcp(perf: PerfResult[]): number {
  const sum = perf.reduce((acc, p) => acc + (p.metrics.lcp ?? 0), 0);
  return sum / perf.length;
}

function formatLcpSeconds(lcpMs: number): string {
  const seconds = lcpMs / 1000;
  return `${seconds.toFixed(1)}s`;
}

export function lcpBadge(result: InspectResult, opts?: BadgeOptions): string {
  const perf = result.perf;
  if (!perf || perf.length === 0) {
    return resolve('LCP', 'n/a', COLOR_UNKNOWN, opts);
  }
  const lcp = averageLcp(perf);
  let color: BadgeColor;
  if (lcp <= 2500) color = COLOR_PASS;
  else if (lcp <= 4000) color = COLOR_WARN;
  else color = COLOR_FAIL;
  return resolve('LCP', formatLcpSeconds(lcp), color, opts);
}

function countVisualDiffs(visual: VisualResult[]): number {
  let total = 0;
  for (const v of visual) {
    if (!v.passed || v.diffPixels > 0) total++;
  }
  return total;
}

export function visualBadge(result: InspectResult, opts?: BadgeOptions): string {
  const visual = result.visual;
  if (!visual || visual.length === 0) {
    return resolve('visual', 'n/a', COLOR_UNKNOWN, opts);
  }
  const diffs = countVisualDiffs(visual);
  const value = `${diffs} diffs`;
  const color: BadgeColor = diffs === 0 ? COLOR_PASS : COLOR_FAIL;
  return resolve('visual', value, color, opts);
}

export async function writeBadges(result: InspectResult, outDir: string): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const files: { name: string; svg: string }[] = [
    { name: 'status.svg', svg: statusBadge(result) },
    { name: 'a11y.svg', svg: a11yBadge(result) },
    { name: 'perf.svg', svg: perfBadge(result) },
    { name: 'lcp.svg', svg: lcpBadge(result) },
    { name: 'visual.svg', svg: visualBadge(result) },
  ];
  const paths: string[] = [];
  for (const f of files) {
    const full = join(outDir, f.name);
    await writeFile(full, f.svg, 'utf8');
    paths.push(full);
  }
  return paths;
}

export const __internal = {
  escapeXml,
  segmentWidth,
  COLOR_PASS,
  COLOR_FAIL,
  COLOR_WARN,
  COLOR_INFO,
  COLOR_UNKNOWN,
};
