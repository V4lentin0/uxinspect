import type { InspectResult, PerfResult, A11yResult, VisualResult, FlowResult } from './types.js';

export type AssertOp = '<' | '<=' | '>' | '>=' | '==' | '!=';
export type AssertValue = string | number | boolean | null;

export interface AssertionSpec {
  [path: string]: string;
}

export interface AssertionViolation {
  path: string;
  expected: string;
  actual: AssertValue | undefined;
  op: AssertOp;
  threshold: AssertValue;
  unit?: string;
}

export interface AssertionResult {
  passed: boolean;
  violations: AssertionViolation[];
}

interface ParsedAssertion {
  op: AssertOp;
  threshold: AssertValue;
  unit?: string;
}

const SUPPORTED_OPS: AssertOp[] = ['<=', '>=', '==', '!=', '<', '>'];

const SUPPORTED_PATHS: readonly string[] = [
  'perf.lcp',
  'perf.cls',
  'perf.tbt',
  'perf.fcp',
  'perf.si',
  'perf.scores.performance',
  'perf.scores.accessibility',
  'perf.scores.bestPractices',
  'perf.scores.seo',
  'a11y.critical',
  'a11y.serious',
  'a11y.moderate',
  'a11y.minor',
  'a11y.total',
  'visual.maxDiffRatio',
  'visual.failed',
  'flows.failed',
  'flows.total',
  'flows.passed',
  'links.broken',
  'consoleErrors.count',
  'consoleErrors.errors',
  'consoleErrors.warnings',
  'passed',
] as const;

export function listSupportedPaths(): readonly string[] {
  return SUPPORTED_PATHS;
}

export function parseAssertion(expr: string): ParsedAssertion {
  if (typeof expr !== 'string') throw new Error(`invalid assertion: ${String(expr)}`);
  const raw = expr.trim();
  if (!raw) throw new Error(`invalid assertion: ${expr}`);
  let op: AssertOp | undefined;
  let rest = '';
  for (const candidate of SUPPORTED_OPS) {
    if (raw.startsWith(candidate)) {
      op = candidate;
      rest = raw.slice(candidate.length).trim();
      break;
    }
  }
  if (!op) throw new Error(`invalid assertion: ${expr}`);
  if (!rest) throw new Error(`invalid assertion: ${expr}`);
  const lower = rest.toLowerCase();
  if (lower === 'true' || lower === 'false') return { op, threshold: lower === 'true' };
  if (lower === 'null') return { op, threshold: null };
  const unitMatch = rest.match(/^(-?\d+(?:\.\d+)?)(ms|s|%)?$/i);
  if (unitMatch) {
    const num = Number(unitMatch[1]);
    if (!Number.isFinite(num)) throw new Error(`invalid assertion: ${expr}`);
    const unit = unitMatch[2]?.toLowerCase();
    if (unit === 's') return { op, threshold: num * 1000, unit: 's' };
    if (unit === '%') return { op, threshold: num / 100, unit: '%' };
    if (unit === 'ms') return { op, threshold: num, unit: 'ms' };
    return { op, threshold: num };
  }
  const stringMatch = rest.match(/^['"](.*)['"]$/);
  if (stringMatch) return { op, threshold: stringMatch[1] };
  throw new Error(`invalid assertion: ${expr}`);
}

function mean(values: number[]): number | undefined {
  if (!values.length) return undefined;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function sum(values: number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

function perfMetric(perf: readonly PerfResult[] | undefined, key: keyof PerfResult['metrics']): number | undefined {
  if (!perf || !perf.length) return undefined;
  return mean(perf.map((p) => p.metrics[key]));
}

function perfScore(perf: readonly PerfResult[] | undefined, key: keyof PerfResult['scores']): number | undefined {
  if (!perf || !perf.length) return undefined;
  return mean(perf.map((p) => p.scores[key]));
}

function a11yCount(a11y: readonly A11yResult[] | undefined, impact: 'critical' | 'serious' | 'moderate' | 'minor'): number {
  if (!a11y) return 0;
  let count = 0;
  for (const r of a11y) {
    for (const v of r.violations) {
      if (v.impact === impact) count++;
    }
  }
  return count;
}

function a11yTotal(a11y: readonly A11yResult[] | undefined): number {
  if (!a11y) return 0;
  let count = 0;
  for (const r of a11y) count += r.violations.length;
  return count;
}

function visualMaxDiff(visual: readonly VisualResult[] | undefined): number | undefined {
  if (!visual || !visual.length) return undefined;
  let max = 0;
  for (const v of visual) {
    if (v.diffRatio > max) max = v.diffRatio;
  }
  return max;
}

function visualFailed(visual: readonly VisualResult[] | undefined): number {
  if (!visual) return 0;
  return visual.filter((v) => v.passed === false).length;
}

function flowsFailed(flows: readonly FlowResult[] | undefined): number {
  if (!flows) return 0;
  return flows.filter((f) => f.passed === false).length;
}

function flowsPassed(flows: readonly FlowResult[] | undefined): number {
  if (!flows) return 0;
  return flows.filter((f) => f.passed === true).length;
}

export function resolveMetric(result: InspectResult, path: string): AssertValue | undefined {
  switch (path) {
    case 'perf.lcp':
      return perfMetric(result.perf, 'lcp');
    case 'perf.cls':
      return perfMetric(result.perf, 'cls');
    case 'perf.tbt':
      return perfMetric(result.perf, 'tbt');
    case 'perf.fcp':
      return perfMetric(result.perf, 'fcp');
    case 'perf.si':
      return perfMetric(result.perf, 'si');
    case 'perf.scores.performance':
      return perfScore(result.perf, 'performance');
    case 'perf.scores.accessibility':
      return perfScore(result.perf, 'accessibility');
    case 'perf.scores.bestPractices':
      return perfScore(result.perf, 'bestPractices');
    case 'perf.scores.seo':
      return perfScore(result.perf, 'seo');
    case 'a11y.critical':
      return a11yCount(result.a11y, 'critical');
    case 'a11y.serious':
      return a11yCount(result.a11y, 'serious');
    case 'a11y.moderate':
      return a11yCount(result.a11y, 'moderate');
    case 'a11y.minor':
      return a11yCount(result.a11y, 'minor');
    case 'a11y.total':
      return a11yTotal(result.a11y);
    case 'visual.maxDiffRatio':
      return visualMaxDiff(result.visual);
    case 'visual.failed':
      return visualFailed(result.visual);
    case 'flows.failed':
      return flowsFailed(result.flows);
    case 'flows.total':
      return result.flows?.length ?? 0;
    case 'flows.passed':
      return flowsPassed(result.flows);
    case 'links.broken': {
      const links = result.links;
      if (!links) return 0;
      return sum(links.map((l) => l.broken.length));
    }
    case 'consoleErrors.count': {
      const ce = result.consoleErrors;
      if (!ce) return 0;
      return sum(ce.map((c) => c.issues.length));
    }
    case 'consoleErrors.errors': {
      const ce = result.consoleErrors;
      if (!ce) return 0;
      return sum(ce.map((c) => c.errorCount));
    }
    case 'consoleErrors.warnings': {
      const ce = result.consoleErrors;
      if (!ce) return 0;
      return sum(ce.map((c) => c.warningCount));
    }
    case 'passed':
      return result.passed;
    default:
      return undefined;
  }
}

function compareNumbers(actual: number, op: AssertOp, threshold: number): boolean {
  switch (op) {
    case '<': return actual < threshold;
    case '<=': return actual <= threshold;
    case '>': return actual > threshold;
    case '>=': return actual >= threshold;
    case '==': return actual === threshold;
    case '!=': return actual !== threshold;
  }
}

function compareBooleans(actual: boolean, op: AssertOp, threshold: boolean): boolean {
  if (op === '==') return actual === threshold;
  if (op === '!=') return actual !== threshold;
  throw new Error(`operator ${op} not allowed for boolean values`);
}

function compareStrings(actual: string, op: AssertOp, threshold: string): boolean {
  if (op === '==') return actual === threshold;
  if (op === '!=') return actual !== threshold;
  throw new Error(`operator ${op} not allowed for string values`);
}

function compareNulls(actual: AssertValue | undefined, op: AssertOp): boolean {
  if (op === '==') return actual === null;
  if (op === '!=') return actual !== null;
  throw new Error(`operator ${op} not allowed for null values`);
}

function evaluateOne(
  path: string,
  expr: string,
  actual: AssertValue | undefined,
  parsed: ParsedAssertion,
): AssertionViolation | undefined {
  const { op, threshold, unit } = parsed;

  if (threshold === null) {
    const ok = compareNulls(actual, op);
    if (ok) return undefined;
    return { path, expected: expr, actual, op, threshold, unit };
  }

  if (actual === undefined) {
    return { path, expected: expr, actual: undefined, op, threshold, unit };
  }

  if (typeof threshold === 'boolean') {
    if (typeof actual !== 'boolean') {
      return { path, expected: expr, actual, op, threshold, unit };
    }
    if (compareBooleans(actual, op, threshold)) return undefined;
    return { path, expected: expr, actual, op, threshold, unit };
  }

  if (typeof threshold === 'string') {
    if (typeof actual !== 'string') {
      return { path, expected: expr, actual, op, threshold, unit };
    }
    if (compareStrings(actual, op, threshold)) return undefined;
    return { path, expected: expr, actual, op, threshold, unit };
  }

  if (typeof threshold === 'number') {
    if (typeof actual !== 'number' || !Number.isFinite(actual)) {
      return { path, expected: expr, actual, op, threshold, unit };
    }
    if (compareNumbers(actual, op, threshold)) return undefined;
    return { path, expected: expr, actual, op, threshold, unit };
  }

  return { path, expected: expr, actual, op, threshold, unit };
}

export function evaluateAssertions(result: InspectResult, spec: AssertionSpec): AssertionResult {
  const violations: AssertionViolation[] = [];
  for (const path of Object.keys(spec)) {
    const expr = spec[path];
    if (typeof expr !== 'string') {
      violations.push({ path, expected: String(expr), actual: undefined, op: '==', threshold: null });
      continue;
    }
    let parsed: ParsedAssertion;
    try {
      parsed = parseAssertion(expr);
    } catch {
      violations.push({ path, expected: expr, actual: undefined, op: '==', threshold: null });
      continue;
    }
    const actual = resolveMetric(result, path);
    let violation: AssertionViolation | undefined;
    try {
      violation = evaluateOne(path, expr, actual, parsed);
    } catch {
      violation = { path, expected: expr, actual, op: parsed.op, threshold: parsed.threshold, unit: parsed.unit };
    }
    if (violation) violations.push(violation);
  }
  return { passed: violations.length === 0, violations };
}

function formatValue(v: AssertValue | undefined, unit?: string): string {
  if (v === undefined) return '<unavailable>';
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    const rounded = Number.isInteger(v) ? v.toString() : v.toFixed(3);
    if (unit === 'ms') return `${rounded}ms`;
    if (unit === 's') return `${rounded}ms`;
    if (unit === '%') return rounded;
    return rounded;
  }
  return String(v);
}

export function formatAssertionFailures(violations: AssertionViolation[]): string {
  if (!violations.length) return '';
  const lines: string[] = [];
  lines.push(`${violations.length} assertion${violations.length === 1 ? '' : 's'} failed:`);
  for (const v of violations) {
    const actualStr = formatValue(v.actual, v.unit);
    lines.push(`  - ${v.path} expected ${v.expected}, got ${actualStr}`);
  }
  return lines.join('\n');
}
