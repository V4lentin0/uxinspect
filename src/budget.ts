import type { InspectResult } from './types.js';

export interface Budget {
  perf?: { performance?: number; accessibility?: number; bestPractices?: number; seo?: number };
  metrics?: { lcpMs?: number; fcpMs?: number; cls?: number; tbtMs?: number; siMs?: number };
  a11y?: { maxCritical?: number; maxSerious?: number; maxTotal?: number };
  visual?: { maxDiffRatio?: number };
  flows?: { maxFailures?: number };
}

export interface BudgetViolation {
  category: string;
  metric: string;
  actual: number;
  limit: number;
  message: string;
}

export function checkBudget(result: InspectResult, budget: Budget): BudgetViolation[] {
  const v: BudgetViolation[] = [];

  if (budget.perf && result.perf) {
    for (const p of result.perf) {
      for (const key of ['performance', 'accessibility', 'bestPractices', 'seo'] as const) {
        const min = budget.perf[key];
        if (min === undefined) continue;
        const score = p.scores[key];
        if (score < min) {
          v.push({
            category: 'perf',
            metric: `${key} (${p.page})`,
            actual: score,
            limit: min,
            message: `${key} score ${score} < ${min}`,
          });
        }
      }
    }
  }

  if (budget.metrics && result.perf) {
    for (const p of result.perf) {
      const m = budget.metrics;
      const checks: [string, number | undefined, number, string][] = [
        ['lcp', m.lcpMs, p.metrics.lcp, 'ms'],
        ['fcp', m.fcpMs, p.metrics.fcp, 'ms'],
        ['tbt', m.tbtMs, p.metrics.tbt, 'ms'],
        ['si', m.siMs, p.metrics.si, 'ms'],
        ['cls', m.cls, p.metrics.cls, ''],
      ];
      for (const [name, limit, actual, unit] of checks) {
        if (limit !== undefined && actual > limit) {
          v.push({
            category: 'metrics',
            metric: `${name} (${p.page})`,
            actual,
            limit,
            message: `${name} ${actual}${unit} > ${limit}${unit}`,
          });
        }
      }
    }
  }

  if (budget.a11y && result.a11y) {
    const all = result.a11y.flatMap((a) => a.violations);
    const critical = all.filter((a) => a.impact === 'critical').length;
    const serious = all.filter((a) => a.impact === 'serious').length;
    if (budget.a11y.maxCritical !== undefined && critical > budget.a11y.maxCritical) {
      v.push({ category: 'a11y', metric: 'critical', actual: critical, limit: budget.a11y.maxCritical, message: `${critical} critical > ${budget.a11y.maxCritical}` });
    }
    if (budget.a11y.maxSerious !== undefined && serious > budget.a11y.maxSerious) {
      v.push({ category: 'a11y', metric: 'serious', actual: serious, limit: budget.a11y.maxSerious, message: `${serious} serious > ${budget.a11y.maxSerious}` });
    }
    if (budget.a11y.maxTotal !== undefined && all.length > budget.a11y.maxTotal) {
      v.push({ category: 'a11y', metric: 'total', actual: all.length, limit: budget.a11y.maxTotal, message: `${all.length} total > ${budget.a11y.maxTotal}` });
    }
  }

  if (budget.visual?.maxDiffRatio !== undefined && result.visual) {
    for (const vr of result.visual) {
      if (vr.diffRatio > budget.visual.maxDiffRatio) {
        v.push({
          category: 'visual',
          metric: `${vr.page} (${vr.viewport})`,
          actual: vr.diffRatio,
          limit: budget.visual.maxDiffRatio,
          message: `${(vr.diffRatio * 100).toFixed(2)}% diff > ${(budget.visual.maxDiffRatio * 100).toFixed(2)}%`,
        });
      }
    }
  }

  if (budget.flows?.maxFailures !== undefined) {
    const fails = result.flows.filter((f) => !f.passed).length;
    if (fails > budget.flows.maxFailures) {
      v.push({ category: 'flows', metric: 'failures', actual: fails, limit: budget.flows.maxFailures, message: `${fails} failed > ${budget.flows.maxFailures}` });
    }
  }

  return v;
}
