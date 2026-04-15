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

export interface StepConsoleCapture {
  step: string;
  issues: ConsoleIssue[];
  errorCount: number;
  warningCount: number;
  passed: boolean;
}

export function attachConsoleCapture(page: Page): {
  result: () => ConsoleCapture;
  beginStep: (stepName: string) => void;
  endStep: () => StepConsoleCapture;
  detach: () => void;
} {
  const attachedAt = performance.now();
  const issues = new Map<string, ConsoleIssue>();
  let stepIssues: Map<string, ConsoleIssue> | null = null;
  let currentStep = 'setup';
  let stepStartedAt = performance.now();

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
    if (existing) {
      existing.occurrences += 1;
    } else {
      issues.set(fp, {
        type,
        message,
        stack: extras.stack,
        url: extras.url,
        lineNumber: extras.lineNumber,
        columnNumber: extras.columnNumber,
        fingerprint: fp,
        occurrences: 1,
        firstSeenMs: performance.now() - attachedAt,
      });
    }
    if (stepIssues) {
      const stepExisting = stepIssues.get(fp);
      if (stepExisting) {
        stepExisting.occurrences += 1;
      } else {
        stepIssues.set(fp, {
          type,
          message,
          stack: extras.stack,
          url: extras.url,
          lineNumber: extras.lineNumber,
          columnNumber: extras.columnNumber,
          fingerprint: fp,
          occurrences: 1,
          firstSeenMs: performance.now() - stepStartedAt,
        });
      }
    }
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
    beginStep: (stepName: string): void => {
      currentStep = stepName;
      stepIssues = new Map<string, ConsoleIssue>();
      stepStartedAt = performance.now();
    },
    endStep: (): StepConsoleCapture => {
      const list = stepIssues ? [...stepIssues.values()] : [];
      const errorCount = list
        .filter((i) => i.type !== 'warning')
        .reduce((n, i) => n + i.occurrences, 0);
      const warningCount = list
        .filter((i) => i.type === 'warning')
        .reduce((n, i) => n + i.occurrences, 0);
      const captured: StepConsoleCapture = {
        step: currentStep,
        issues: list,
        errorCount,
        warningCount,
        passed: errorCount === 0,
      };
      stepIssues = null;
      return captured;
    },
    detach: (): void => {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('requestfailed', onRequestFailed);
    },
  };
}
