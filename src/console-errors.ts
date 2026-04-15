import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Page, ConsoleMessage, Request } from 'playwright';

export interface ConsoleIssue {
  type: 'error' | 'warning' | 'pageerror' | 'unhandledrejection';
  message: string;
  stack?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  fingerprint: string;
  occurrences: number;
  firstSeenMs: number;
}

export interface ConsoleCapture {
  page: string;
  issues: ConsoleIssue[];
  errorCount: number;
  warningCount: number;
  passed: boolean;
}

export interface StepConsoleError {
  type: ConsoleIssue['type'];
  message: string;
  stack?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  atMs: number;
}

export interface StepCapture {
  end(): { errors: StepConsoleError[]; step: string };
}

export interface ConsoleCaptureHandle {
  result: () => ConsoleCapture;
  detach: () => void;
  markStepStart: (stepLabel: string) => StepCapture;
}

function normalize(message: string): string {
  return message
    .replace(/(?:[a-zA-Z]:)?(?:\/|\\)[^\s:'")]+/g, '<path>')
    .replace(/\b\d+\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstFrame(stack?: string): string {
  if (!stack) return '';
  const lines = stack.split('\n').map((l) => l.trim()).filter(Boolean);
  const frame = lines.find((l) => l.startsWith('at ')) ?? lines[1] ?? '';
  return normalize(frame);
}

function fingerprintOf(
  type: ConsoleIssue['type'],
  normalizedMessage: string,
  stack: string | undefined,
): string {
  const key = `${type}|${normalizedMessage}|${firstFrame(stack)}`;
  return createHash('sha256').update(key).digest('hex');
}

export function attachConsoleCapture(page: Page): ConsoleCaptureHandle {
  const attachedAt = performance.now();
  const issues = new Map<string, ConsoleIssue>();
  const timeline: StepConsoleError[] = [];

  const record = (
    type: ConsoleIssue['type'],
    message: string,
    extras: {
      stack?: string;
      url?: string;
      lineNumber?: number;
      columnNumber?: number;
    } = {},
  ): void => {
    const normalized = normalize(message);
    const fp = fingerprintOf(type, normalized, extras.stack);
    const existing = issues.get(fp);
    const atMs = performance.now() - attachedAt;
    timeline.push({
      type,
      message,
      stack: extras.stack,
      url: extras.url,
      lineNumber: extras.lineNumber,
      columnNumber: extras.columnNumber,
      atMs,
    });
    if (existing) {
      existing.occurrences += 1;
      return;
    }
    issues.set(fp, {
      type,
      message,
      stack: extras.stack,
      url: extras.url,
      lineNumber: extras.lineNumber,
      columnNumber: extras.columnNumber,
      fingerprint: fp,
      occurrences: 1,
      firstSeenMs: atMs,
    });
  };

  const onConsole = (msg: ConsoleMessage): void => {
    const t = msg.type();
    if (t !== 'error' && t !== 'warning') return;
    const loc = msg.location();
    record(t, msg.text(), {
      url: loc.url || undefined,
      lineNumber: loc.lineNumber,
      columnNumber: loc.columnNumber,
    });
  };

  const onPageError = (err: Error): void => {
    const msg = err.message || String(err);
    const type: ConsoleIssue['type'] = /unhandled(?:\s|promise)/i.test(msg)
      ? 'unhandledrejection'
      : 'pageerror';
    record(type, msg, { stack: err.stack });
  };

  const onRequestFailed = (req: Request): void => {
    const failure = req.failure();
    const reason = failure?.errorText ?? 'request failed';
    record('error', `${req.method()} ${req.url()} failed: ${reason}`, {
      url: req.url(),
    });
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('requestfailed', onRequestFailed);

  return {
    result: (): ConsoleCapture => {
      const list = [...issues.values()];
      const errorCount = list
        .filter((i) => i.type !== 'warning')
        .reduce((n, i) => n + i.occurrences, 0);
      const warningCount = list
        .filter((i) => i.type === 'warning')
        .reduce((n, i) => n + i.occurrences, 0);
      return {
        page: page.url(),
        issues: list,
        errorCount,
        warningCount,
        passed: errorCount === 0,
      };
    },
    detach: (): void => {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('requestfailed', onRequestFailed);
    },
    markStepStart: (stepLabel: string): StepCapture => {
      const startMs = performance.now() - attachedAt;
      return {
        end: (): { errors: StepConsoleError[]; step: string } => {
          const endMs = performance.now() - attachedAt;
          const errors = timeline.filter(
            (e) => e.atMs >= startMs && e.atMs <= endMs,
          );
          return { errors, step: stepLabel };
        },
      };
    },
  };
}
