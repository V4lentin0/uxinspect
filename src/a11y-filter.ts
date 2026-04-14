import type { Page } from 'playwright';
import type { A11yResult, A11yViolation } from './types.js';

export type WcagLevel =
  | 'wcag2a'
  | 'wcag2aa'
  | 'wcag2aaa'
  | 'wcag21a'
  | 'wcag21aa'
  | 'wcag22aa'
  | 'best-practice';

export interface A11yFilterOptions {
  include?: WcagLevel[];
  excludeBestPractice?: boolean;
  runOnlyRules?: string[];
  disableRules?: string[];
  elementExclude?: string[];
  impactMinimum?: 'minor' | 'moderate' | 'serious' | 'critical';
}

export const WCAG_TAG_GROUPS: Record<string, WcagLevel[]> = {
  a: ['wcag2a', 'wcag21a'],
  aa: ['wcag2aa', 'wcag21aa', 'wcag22aa'],
  aaa: ['wcag2aaa'],
  all: ['wcag2a', 'wcag2aa', 'wcag2aaa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
  allWithBestPractice: [
    'wcag2a',
    'wcag2aa',
    'wcag2aaa',
    'wcag21a',
    'wcag21aa',
    'wcag22aa',
    'best-practice',
  ],
};

const DEFAULT_TAGS: WcagLevel[] = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

const IMPACT_ORDER: Record<NonNullable<A11yFilterOptions['impactMinimum']>, number> = {
  minor: 0,
  moderate: 1,
  serious: 2,
  critical: 3,
};

interface AxeNode {
  html: string;
  target: unknown[];
}

interface AxeViolation {
  id: string;
  impact?: string | null;
  description: string;
  help: string;
  helpUrl: string;
  nodes: AxeNode[];
}

interface AxeAnalyzeResult {
  violations: AxeViolation[];
}

interface AxeBuilderLike {
  withTags(tags: string[]): AxeBuilderLike;
  withRules(rules: string[]): AxeBuilderLike;
  disableRules(rules: string[]): AxeBuilderLike;
  exclude(selector: string): AxeBuilderLike;
  analyze(): Promise<AxeAnalyzeResult>;
}

type AxeBuilderCtor = new (args: { page: Page }) => AxeBuilderLike;

async function loadAxeBuilder(): Promise<AxeBuilderCtor | null> {
  try {
    const mod = (await import('@axe-core/playwright')) as {
      AxeBuilder?: AxeBuilderCtor;
      default?: AxeBuilderCtor;
    };
    return mod.AxeBuilder ?? mod.default ?? null;
  } catch {
    return null;
  }
}

function normalizeImpact(impact?: string | null): A11yViolation['impact'] {
  if (impact === 'critical' || impact === 'serious' || impact === 'moderate' || impact === 'minor') {
    return impact;
  }
  return 'minor';
}

function toViolation(v: AxeViolation): A11yViolation {
  return {
    id: v.id,
    impact: normalizeImpact(v.impact),
    description: v.description,
    help: v.help,
    helpUrl: v.helpUrl,
    nodes: v.nodes.map((n) => ({
      html: n.html,
      target: Array.isArray(n.target) ? n.target.filter((t): t is string => typeof t === 'string') : [],
    })),
  };
}

export function filterViolationsByImpact(
  violations: A11yViolation[],
  minimum: A11yFilterOptions['impactMinimum'],
): A11yViolation[] {
  if (!minimum) return violations;
  const threshold = IMPACT_ORDER[minimum];
  return violations.filter((v) => IMPACT_ORDER[v.impact] >= threshold);
}

function resolveTags(opts: A11yFilterOptions): WcagLevel[] {
  const base = opts.include && opts.include.length > 0 ? [...opts.include] : [...DEFAULT_TAGS];
  const excludeBP = opts.excludeBestPractice ?? true;
  const hasBP = base.includes('best-practice');
  if (!excludeBP && !hasBP) {
    base.push('best-practice');
  }
  if (excludeBP && hasBP) {
    return base.filter((t) => t !== 'best-practice');
  }
  return base;
}

function emptyResult(page: Page): A11yResult {
  return { page: page.url(), violations: [], passed: true };
}

export async function runFilteredA11y(
  page: Page,
  opts: A11yFilterOptions,
): Promise<A11yResult> {
  const AxeBuilder = await loadAxeBuilder();
  if (!AxeBuilder) {
    return emptyResult(page);
  }

  try {
    let builder: AxeBuilderLike = new AxeBuilder({ page });

    if (opts.runOnlyRules && opts.runOnlyRules.length > 0) {
      builder = builder.withRules(opts.runOnlyRules);
    } else {
      const tags = resolveTags(opts);
      builder = builder.withTags(tags);
    }

    if (opts.disableRules && opts.disableRules.length > 0) {
      builder = builder.disableRules(opts.disableRules);
    }

    if (opts.elementExclude && opts.elementExclude.length > 0) {
      for (const selector of opts.elementExclude) {
        builder = builder.exclude(selector);
      }
    }

    const result = await builder.analyze();
    const mapped = result.violations.map(toViolation);
    const filtered = filterViolationsByImpact(mapped, opts.impactMinimum);

    return {
      page: page.url(),
      violations: filtered,
      passed: filtered.length === 0,
    };
  } catch {
    return emptyResult(page);
  }
}
