// Retry wrappers with exponential backoff + jitter.

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: 'full' | 'equal' | 'none';
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, nextDelayMs: number) => void;
  signal?: AbortSignal;
}

export interface RetryResult<T> {
  value?: T;
  error?: unknown;
  attempts: number;
  totalDelayMs: number;
  succeeded: boolean;
}

interface Normalized {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: 'full' | 'equal' | 'none';
  shouldRetry: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, nextDelayMs: number) => void;
  signal?: AbortSignal;
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function makeAbortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

function normalize(opts?: RetryOptions): Normalized {
  const baseDelayMs = clamp(Math.floor(opts?.baseDelayMs ?? 500), 10, 60_000);
  return {
    maxAttempts: clamp(Math.floor(opts?.maxAttempts ?? 3), 1, 10),
    baseDelayMs,
    maxDelayMs: clamp(Math.floor(opts?.maxDelayMs ?? 10_000), baseDelayMs, 300_000),
    jitter: opts?.jitter ?? 'equal',
    shouldRetry: opts?.shouldRetry ?? ((err) => !isAbortError(err)),
    onRetry: opts?.onRetry,
    signal: opts?.signal,
  };
}

export function computeBackoff(
  attempt: number,
  base: number,
  max: number,
  jitter: 'full' | 'equal' | 'none',
): number {
  const safe = attempt < 1 ? 1 : Math.floor(attempt);
  const exponent = safe - 1 > 30 ? 30 : safe - 1;
  const raw = base * Math.pow(2, exponent);
  const exp = raw > max ? max : raw;
  if (jitter === 'none') return exp;
  if (jitter === 'full') return Math.random() * exp;
  const half = exp / 2;
  return half + Math.random() * half;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function runLoop<T>(fn: () => Promise<T>, n: Normalized): Promise<RetryResult<T>> {
  let attempts = 0;
  let totalDelayMs = 0;
  let lastError: unknown;

  for (let attempt = 1; attempt <= n.maxAttempts; attempt++) {
    if (n.signal?.aborted) {
      return { error: makeAbortError(), attempts, totalDelayMs, succeeded: false };
    }
    attempts = attempt;
    try {
      const value = await fn();
      return { value, attempts, totalDelayMs, succeeded: true };
    } catch (err) {
      lastError = err;
      if (isAbortError(err)) {
        return { error: err, attempts, totalDelayMs, succeeded: false };
      }
      if (attempt >= n.maxAttempts) break;
      let keepGoing = true;
      try {
        keepGoing = n.shouldRetry(err, attempt);
      } catch {
        keepGoing = false;
      }
      if (!keepGoing) break;

      const delay = computeBackoff(attempt, n.baseDelayMs, n.maxDelayMs, n.jitter);
      const waitMs = delay < 0 ? 0 : Math.floor(delay);

      if (n.onRetry) {
        try {
          n.onRetry(err, attempt, waitMs);
        } catch {
          // swallow onRetry errors.
        }
      }

      await sleep(waitMs, n.signal);
      totalDelayMs += waitMs;

      if (n.signal?.aborted) {
        return { error: makeAbortError(), attempts, totalDelayMs, succeeded: false };
      }
    }
  }

  return { error: lastError, attempts, totalDelayMs, succeeded: false };
}

export async function retry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  const result = await runLoop(fn, normalize(opts));
  if (result.succeeded) return result.value as T;
  throw result.error;
}

export async function retryWithStats<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<RetryResult<T>> {
  try {
    return await runLoop(fn, normalize(opts));
  } catch (err) {
    return { error: err, attempts: 0, totalDelayMs: 0, succeeded: false };
  }
}
