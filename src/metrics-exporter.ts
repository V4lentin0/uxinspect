import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { InspectResult } from './types.js';

export interface MetricPoint {
  name: string;
  help: string;
  unit?: string;
  value: number;
  labels: Record<string, string>;
  kind: 'counter' | 'gauge' | 'histogram';
}

export interface OtlpPushOptions {
  endpoint: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

interface OtlpKeyValue {
  key: string;
  value: { stringValue: string };
}

interface OtlpDataPoint {
  attributes: OtlpKeyValue[];
  timeUnixNano: string;
  asDouble: number;
}

interface OtlpMetricGauge {
  name: string;
  description: string;
  unit: string;
  gauge: { dataPoints: OtlpDataPoint[] };
}

interface OtlpMetricSum {
  name: string;
  description: string;
  unit: string;
  sum: {
    dataPoints: OtlpDataPoint[];
    aggregationTemporality: number;
    isMonotonic: boolean;
  };
}

type OtlpMetric = OtlpMetricGauge | OtlpMetricSum;

interface OtlpScopeMetrics {
  scope: { name: string; version: string };
  metrics: OtlpMetric[];
}

interface OtlpResourceMetrics {
  resource: { attributes: OtlpKeyValue[] };
  scopeMetrics: OtlpScopeMetrics[];
}

interface OtlpPayload {
  resourceMetrics: OtlpResourceMetrics[];
}

const SCOPE_NAME = 'uxinspect';
const VALID_METRIC_CHAR = /[a-zA-Z0-9_:]/;
const VALID_METRIC_START = /[a-zA-Z_:]/;
const VALID_LABEL_START = /[a-zA-Z_]/;
const VALID_LABEL_CHAR = /[a-zA-Z0-9_]/;

function sanitizeMetricName(name: string): string {
  if (!name) return '_';
  const chars = [...name];
  const first = chars[0];
  let out = first && VALID_METRIC_START.test(first) ? first : '_';
  for (let i = 1; i < chars.length; i++) {
    const c = chars[i];
    out += c && VALID_METRIC_CHAR.test(c) ? c : '_';
  }
  return out;
}

function sanitizeLabelKey(key: string): string {
  if (!key) return '_';
  const chars = [...key];
  const first = chars[0];
  let out = first && VALID_LABEL_START.test(first) ? first : '_';
  for (let i = 1; i < chars.length; i++) {
    const c = chars[i];
    out += c && VALID_LABEL_CHAR.test(c) ? c : '_';
  }
  return out;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(here, '..', 'package.json'),
      resolve(here, '..', '..', 'package.json'),
    ];
    for (const p of candidates) {
      try {
        const raw = readFileSync(p, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed &&
          typeof parsed === 'object' &&
          'name' in parsed &&
          'version' in parsed &&
          (parsed as { name: unknown }).name === 'uxinspect' &&
          typeof (parsed as { version: unknown }).version === 'string'
        ) {
          return (parsed as { version: string }).version;
        }
      } catch {
        continue;
      }
    }
  } catch {
    // ignore
  }
  return 'unknown';
}

function defaultResourceAttrs(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {
    'service.name': 'uxinspect',
    'service.version': readPackageVersion(),
  };
  const env = process.env.NODE_ENV;
  if (env) out['deployment.environment'] = env;
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      out[k] = v;
    }
  }
  return out;
}

function push(
  out: MetricPoint[],
  name: string,
  help: string,
  kind: MetricPoint['kind'],
  value: number,
  labels: Record<string, string>,
  unit?: string,
): void {
  out.push({ name: sanitizeMetricName(name), help, kind, value, labels, unit });
}

function mergeLabels(
  base: Record<string, string>,
  extra: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) merged[sanitizeLabelKey(k)] = v;
  for (const [k, v] of Object.entries(extra)) merged[sanitizeLabelKey(k)] = v;
  return merged;
}

export function extractMetrics(
  result: InspectResult,
  resourceAttrs?: Record<string, string>,
): MetricPoint[] {
  const out: MetricPoint[] = [];
  const base: Record<string, string> = { url: result.url };
  if (resourceAttrs) {
    for (const [k, v] of Object.entries(resourceAttrs)) base[sanitizeLabelKey(k)] = v;
  }

  push(out, 'uxinspect_passed', 'Overall run passed (1) or failed (0)', 'gauge', result.passed ? 1 : 0, base);
  push(out, 'uxinspect_duration_ms', 'Total run duration in milliseconds', 'gauge', result.durationMs, base, 'ms');

  const flows = result.flows ?? [];
  push(out, 'uxinspect_flows_total', 'Total number of flows executed', 'counter', flows.length, base);
  push(out, 'uxinspect_flows_passed', 'Total number of flows that passed', 'counter', flows.filter((f) => f.passed).length, base);

  const a11y = result.a11y ?? [];
  let critical = 0;
  let serious = 0;
  for (const page of a11y) {
    for (const v of page.violations) {
      if (v.impact === 'critical') critical++;
      else if (v.impact === 'serious') serious++;
    }
  }
  push(out, 'uxinspect_a11y_critical_total', 'Count of critical accessibility violations', 'counter', critical, base);
  push(out, 'uxinspect_a11y_serious_total', 'Count of serious accessibility violations', 'counter', serious, base);

  const visual = result.visual ?? [];
  const visualDiffs = visual.filter((v) => !v.passed).length;
  push(out, 'uxinspect_visual_diffs_total', 'Count of failing visual regression diffs', 'counter', visualDiffs, base);

  const perf = result.perf ?? [];
  for (const p of perf) {
    const pl = mergeLabels(base, { page: p.page });
    push(out, 'uxinspect_perf_lcp_ms', 'Largest Contentful Paint in milliseconds', 'gauge', p.metrics.lcp, pl, 'ms');
    push(out, 'uxinspect_perf_cls', 'Cumulative Layout Shift (unitless)', 'gauge', p.metrics.cls, pl);
    push(out, 'uxinspect_perf_fcp_ms', 'First Contentful Paint in milliseconds', 'gauge', p.metrics.fcp, pl, 'ms');
    push(out, 'uxinspect_perf_tbt_ms', 'Total Blocking Time in milliseconds', 'gauge', p.metrics.tbt, pl, 'ms');
    push(out, 'uxinspect_perf_si_ms', 'Speed Index in milliseconds', 'gauge', p.metrics.si, pl, 'ms');
  }

  const links = result.links ?? [];
  let brokenLinks = 0;
  for (const l of links) brokenLinks += l.broken.length;
  push(out, 'uxinspect_links_broken_total', 'Count of broken links found', 'counter', brokenLinks, base);

  const consoleErrors = result.consoleErrors ?? [];
  let errCount = 0;
  for (const c of consoleErrors) errCount += c.errorCount;
  push(out, 'uxinspect_console_errors_total', 'Count of console errors captured', 'counter', errCount, base);

  const budget = result.budget ?? [];
  push(out, 'uxinspect_budget_violations_total', 'Count of budget violations', 'counter', budget.length, base);

  const security = result.security;
  let missingHeaders = 0;
  if (security) missingHeaders = security.issues.filter((i) => i.startsWith('missing ')).length;
  push(out, 'uxinspect_security_headers_missing_total', 'Count of missing security headers', 'counter', missingHeaders, base);

  const bundles = result.bundleSize ?? [];
  for (const b of bundles) {
    const bl = mergeLabels(base, { page: b.page });
    push(out, 'uxinspect_bundle_size_bytes_total', 'Total bundle size in bytes (JS + CSS)', 'gauge', b.totalJsBytes + b.totalCssBytes, bl, 'By');
  }

  const forms = result.forms ?? [];
  let formIssues = 0;
  for (const f of forms) formIssues += f.totalIssues;
  push(out, 'uxinspect_forms_issues_total', 'Count of forms audit issues', 'counter', formIssues, base);

  const deadImages = result.deadImages ?? [];
  let deadImgCount = 0;
  for (const d of deadImages) deadImgCount += d.brokenCount;
  push(out, 'uxinspect_dead_images_total', 'Count of broken or placeholder-only images', 'counter', deadImgCount, base);

  const domSize = result.domSize ?? [];
  for (const d of domSize) {
    const dl = mergeLabels(base, { page: d.page });
    push(out, 'uxinspect_dom_nodes', 'Total DOM node count for a page', 'gauge', d.totalNodes, dl);
  }

  return out;
}

interface GroupedMetric {
  name: string;
  help: string;
  kind: MetricPoint['kind'];
  unit?: string;
  points: MetricPoint[];
}

function groupMetrics(metrics: MetricPoint[]): GroupedMetric[] {
  const map = new Map<string, GroupedMetric>();
  for (const m of metrics) {
    const existing = map.get(m.name);
    if (existing) {
      existing.points.push(m);
    } else {
      map.set(m.name, { name: m.name, help: m.help, kind: m.kind, unit: m.unit, points: [m] });
    }
  }
  return [...map.values()];
}

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const pairs = keys.map((k) => `${sanitizeLabelKey(k)}="${escapeLabelValue(labels[k] ?? '')}"`);
  return `{${pairs.join(',')}}`;
}

function formatValue(v: number): string {
  if (!Number.isFinite(v)) {
    if (Number.isNaN(v)) return 'NaN';
    return v > 0 ? '+Inf' : '-Inf';
  }
  if (Number.isInteger(v)) return v.toString();
  return v.toString();
}

function escapeHelp(help: string): string {
  return help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function promKind(kind: MetricPoint['kind']): string {
  if (kind === 'counter') return 'counter';
  if (kind === 'histogram') return 'histogram';
  return 'gauge';
}

export function toPrometheusText(metrics: MetricPoint[]): string {
  const groups = groupMetrics(metrics);
  const lines: string[] = [];
  for (const g of groups) {
    lines.push(`# HELP ${g.name} ${escapeHelp(g.help)}`);
    lines.push(`# TYPE ${g.name} ${promKind(g.kind)}`);
    for (const p of g.points) {
      lines.push(`${g.name}${formatLabels(p.labels)} ${formatValue(p.value)}`);
    }
  }
  return lines.join('\n') + '\n';
}

function toAttrs(labels: Record<string, string>): OtlpKeyValue[] {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => ({ key: sanitizeLabelKey(k), value: { stringValue: labels[k] ?? '' } }));
}

export function toOtlpJson(
  metrics: MetricPoint[],
  resourceAttrs?: Record<string, string>,
): unknown {
  const attrs = defaultResourceAttrs(resourceAttrs);
  const timeUnixNano = (Date.now() * 1_000_000).toString();
  const groups = groupMetrics(metrics);
  const otlpMetrics: OtlpMetric[] = groups.map((g) => {
    const dataPoints: OtlpDataPoint[] = g.points.map((p) => ({
      attributes: toAttrs(p.labels),
      timeUnixNano,
      asDouble: Number.isFinite(p.value) ? p.value : 0,
    }));
    const description = g.help;
    const unit = g.unit ?? '';
    if (g.kind === 'counter') {
      return {
        name: g.name,
        description,
        unit,
        sum: { dataPoints, aggregationTemporality: 2, isMonotonic: true },
      };
    }
    return { name: g.name, description, unit, gauge: { dataPoints } };
  });

  const payload: OtlpPayload = {
    resourceMetrics: [
      {
        resource: { attributes: toAttrs(attrs) },
        scopeMetrics: [
          {
            scope: { name: SCOPE_NAME, version: readPackageVersion() },
            metrics: otlpMetrics,
          },
        ],
      },
    ],
  };
  return payload;
}

export async function pushOtlp(
  metrics: MetricPoint[],
  opts: OtlpPushOptions,
  resourceAttrs?: Record<string, string>,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const timeout = opts.timeoutMs ?? 10_000;
  const body = JSON.stringify(toOtlpJson(metrics, resourceAttrs));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(opts.headers ?? {}),
    };
    const res = await fetch(opts.endpoint, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      let text = '';
      try {
        text = await res.text();
      } catch {
        text = '';
      }
      return { ok: false, status: res.status, error: text.slice(0, 500) };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
