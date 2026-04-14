import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { InspectConfig, InspectResult } from './types.js';

const execFileP = promisify(execFile);

export interface BisectOptions {
  cfg: InspectConfig;
  goodCommit: string;
  badCommit: string;
  isRegression: (result: InspectResult) => boolean;
  repoDir?: string;
  checkoutCmd?: string[];
  maxIterations?: number;
  beforeRun?: (commit: string) => Promise<void>;
}

export interface BisectStep {
  commit: string;
  passed: boolean;
  result: InspectResult;
}

export interface BisectResult {
  firstBadCommit: string | null;
  steps: BisectStep[];
  iterations: number;
  reason: 'found' | 'max-iterations' | 'inconclusive';
  error?: string;
}

interface GitRunOptions {
  cwd: string;
}

async function runGit(args: string[], opts: GitRunOptions): Promise<string> {
  const { stdout } = await execFileP('git', args, {
    cwd: opts.cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
}

async function currentRef(cwd: string): Promise<string> {
  const symbolic = await execFileP('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd,
    maxBuffer: 1024 * 1024,
  }).catch(() => null);
  if (symbolic && symbolic.stdout.trim().length > 0) {
    return symbolic.stdout.trim();
  }
  return runGit(['rev-parse', 'HEAD'], { cwd });
}

async function revList(good: string, bad: string, cwd: string): Promise<string[]> {
  const raw = await runGit(['rev-list', `${good}..${bad}`], { cwd });
  if (raw.length === 0) return [];
  return raw.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
}

async function checkout(
  commit: string,
  cwd: string,
  checkoutCmd: string[],
): Promise<void> {
  if (checkoutCmd.length === 0) {
    throw new Error('checkoutCmd must contain at least the executable');
  }
  const [bin, ...rest] = checkoutCmd;
  const args = [...rest, commit];
  await execFileP(bin, args, { cwd, maxBuffer: 8 * 1024 * 1024 });
}

interface LoadedInspector {
  inspect: (cfg: InspectConfig) => Promise<InspectResult>;
}

async function loadInspector(): Promise<LoadedInspector> {
  const mod = (await import('./index.js')) as Partial<LoadedInspector>;
  if (typeof mod.inspect !== 'function') {
    throw new Error('inspect() not found on ./index.js export');
  }
  return { inspect: mod.inspect };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export async function bisect(opts: BisectOptions): Promise<BisectResult> {
  const repoDir = opts.repoDir ?? process.cwd();
  const checkoutCmd = opts.checkoutCmd ?? ['git', 'checkout', '--quiet'];
  const maxIterations = opts.maxIterations ?? 20;

  const steps: BisectStep[] = [];
  let iterations = 0;
  let originalRef: string | null = null;

  try {
    originalRef = await currentRef(repoDir);
  } catch (err) {
    return {
      firstBadCommit: null,
      steps,
      iterations,
      reason: 'inconclusive',
      error: `failed to read current HEAD: ${errorMessage(err)}`,
    };
  }

  let commits: string[];
  try {
    commits = await revList(opts.goodCommit, opts.badCommit, repoDir);
  } catch (err) {
    return {
      firstBadCommit: null,
      steps,
      iterations,
      reason: 'inconclusive',
      error: `git rev-list failed: ${errorMessage(err)}`,
    };
  }

  if (commits.length === 0) {
    try {
      await checkout(originalRef, repoDir, checkoutCmd);
    } catch {
      // best-effort restore
    }
    return {
      firstBadCommit: null,
      steps,
      iterations,
      reason: 'inconclusive',
      error: 'empty commit range between goodCommit and badCommit',
    };
  }

  let inspector: LoadedInspector;
  try {
    inspector = await loadInspector();
  } catch (err) {
    try {
      await checkout(originalRef, repoDir, checkoutCmd);
    } catch {
      // best-effort restore
    }
    return {
      firstBadCommit: null,
      steps,
      iterations,
      reason: 'inconclusive',
      error: `failed to load inspector: ${errorMessage(err)}`,
    };
  }

  // commits is ordered newest-first from `git rev-list good..bad`
  // We want oldest-first for a predictable midpoint search.
  const orderedOldFirst = [...commits].reverse();
  let candidates = orderedOldFirst;
  let firstBadCommit: string | null = null;
  let finalReason: BisectResult['reason'] = 'inconclusive';
  let finalError: string | undefined;

  try {
    while (candidates.length > 0) {
      if (iterations >= maxIterations) {
        finalReason = 'max-iterations';
        finalError = `exceeded maxIterations (${maxIterations})`;
        break;
      }

      const midIdx = Math.floor((candidates.length - 1) / 2);
      const candidate = candidates[midIdx];
      iterations += 1;

      try {
        await checkout(candidate, repoDir, checkoutCmd);
      } catch (err) {
        finalReason = 'inconclusive';
        finalError = `checkout failed for ${candidate}: ${errorMessage(err)}`;
        break;
      }

      if (opts.beforeRun) {
        try {
          await opts.beforeRun(candidate);
        } catch (err) {
          finalReason = 'inconclusive';
          finalError = `beforeRun failed for ${candidate}: ${errorMessage(err)}`;
          break;
        }
      }

      let result: InspectResult;
      try {
        result = await inspector.inspect(opts.cfg);
      } catch (err) {
        finalReason = 'inconclusive';
        finalError = `inspect() failed for ${candidate}: ${errorMessage(err)}`;
        break;
      }

      const isBad = opts.isRegression(result);
      steps.push({ commit: candidate, passed: !isBad, result });

      if (isBad) {
        firstBadCommit = candidate;
        // first-bad is somewhere in [0..midIdx], inclusive of midIdx
        candidates = candidates.slice(0, midIdx);
      } else {
        // good at midIdx, so first-bad (if any) is in (midIdx..end]
        candidates = candidates.slice(midIdx + 1);
      }
    }

    if (finalReason === 'inconclusive' && finalError === undefined) {
      finalReason = firstBadCommit !== null ? 'found' : 'inconclusive';
      if (firstBadCommit === null) {
        finalError = 'no commit in range classified as regression';
      }
    }
  } finally {
    try {
      await checkout(originalRef, repoDir, checkoutCmd);
    } catch {
      // best-effort restore; do not overwrite existing finalError
    }
  }

  return {
    firstBadCommit,
    steps,
    iterations,
    reason: finalReason,
    ...(finalError !== undefined ? { error: finalError } : {}),
  };
}

interface DefaultOracleThresholds {
  lcpIncrease?: number;
  perfScoreDrop?: number;
  a11yCriticalIncrease?: number;
}

function averageLcp(result: InspectResult): number {
  if (!result.perf || result.perf.length === 0) return 0;
  let total = 0;
  let count = 0;
  for (const p of result.perf) {
    total += p.metrics.lcp;
    count += 1;
  }
  return count === 0 ? 0 : total / count;
}

function averagePerfScore(result: InspectResult): number {
  if (!result.perf || result.perf.length === 0) return 100;
  let total = 0;
  let count = 0;
  for (const p of result.perf) {
    total += p.scores.performance;
    count += 1;
  }
  return count === 0 ? 100 : total / count;
}

function criticalA11yCount(result: InspectResult): number {
  if (!result.a11y) return 0;
  let count = 0;
  for (const page of result.a11y) {
    for (const v of page.violations) {
      if (v.impact === 'critical') count += 1;
    }
  }
  return count;
}

export function defaultRegressionOracle(
  baseline: InspectResult,
  thresholds?: DefaultOracleThresholds,
): (current: InspectResult) => boolean {
  const lcpIncrease = thresholds?.lcpIncrease ?? 200;
  const perfScoreDrop = thresholds?.perfScoreDrop ?? 5;
  const a11yCriticalIncrease = thresholds?.a11yCriticalIncrease ?? 1;

  const baselineLcp = averageLcp(baseline);
  const baselinePerf = averagePerfScore(baseline);
  const baselineA11y = criticalA11yCount(baseline);

  return (current: InspectResult): boolean => {
    const currentLcp = averageLcp(current);
    if (currentLcp - baselineLcp >= lcpIncrease) return true;

    const currentPerf = averagePerfScore(current);
    if (baselinePerf - currentPerf >= perfScoreDrop) return true;

    const currentA11y = criticalA11yCount(current);
    if (currentA11y - baselineA11y >= a11yCriticalIncrease) return true;

    return false;
  };
}
