export interface FlakeError {
  attempt: number;
  message: string;
  transient: boolean;
}

export interface FlakeResult<T> {
  value?: T;
  passed: boolean;
  attempts: number;
  flaky: boolean;
  errors: FlakeError[];
  totalMs: number;
}

export interface RetryOptions {
  maxAttempts?: number;
  backoffMs?: number;
  isTransient?: (err: unknown) => boolean;
}

const TRANSIENT_PATTERN = /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|navigation failed|page closed|browser has been closed|element is not attached|stale|waiting for selector|waiting for locator/i;

const HTTP_TRANSIENT_PATTERN = /\b(502|503|504)\b/;

const NON_TRANSIENT_PATTERN = /assertion|assert failed|expect\(|expected .* to |syntaxerror|syntax error|permission denied|eacces|eperm/i;

export function defaultIsTransient(err: unknown): boolean {
  const msg = errorMessage(err);
  if (!msg) return false;
  if (NON_TRANSIENT_PATTERN.test(msg)) return false;
  if (TRANSIENT_PATTERN.test(msg)) return true;
  if (HTTP_TRANSIENT_PATTERN.test(msg)) return true;
  return false;
}

export async function retryWithFlakeDetection<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<FlakeResult<T>> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const backoffMs = Math.max(0, opts.backoffMs ?? 500);
  const isTransient = opts.isTransient ?? defaultIsTransient;

  const start = Date.now();
  const errors: FlakeError[] = [];
  let attempts = 0;

  for (let i = 0; i < maxAttempts; i++) {
    attempts = i + 1;
    try {
      const value = await fn();
      return {
        value,
        passed: true,
        attempts,
        flaky: attempts > 1,
        errors,
        totalMs: Date.now() - start,
      };
    } catch (e) {
      const message = errorMessage(e) ?? String(e);
      const transient = isTransient(e);
      errors.push({ attempt: attempts, message, transient });

      if (!transient) {
        return {
          passed: false,
          attempts,
          flaky: false,
          errors,
          totalMs: Date.now() - start,
        };
      }

      if (attempts >= maxAttempts) break;

      const delay = backoffMs * Math.pow(2, i);
      if (delay > 0) await sleep(delay);
    }
  }

  return {
    passed: false,
    attempts,
    flaky: false,
    errors,
    totalMs: Date.now() - start,
  };
}

export function classifyFlakeRate(results: FlakeResult<unknown>[]): {
  flakeRate: number;
  totalRuns: number;
  flakyRuns: number;
  brokenRuns: number;
  passedRuns: number;
} {
  const totalRuns = results.length;
  let flakyRuns = 0;
  let brokenRuns = 0;
  let passedRuns = 0;

  for (const r of results) {
    if (r.passed && r.flaky) {
      flakyRuns++;
      passedRuns++;
    } else if (r.passed) {
      passedRuns++;
    } else {
      brokenRuns++;
    }
  }

  const flakeRate = totalRuns === 0 ? 0 : flakyRuns / totalRuns;

  return { flakeRate, totalRuns, flakyRuns, brokenRuns, passedRuns };
}

function errorMessage(err: unknown): string | undefined {
  if (err == null) return undefined;
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
