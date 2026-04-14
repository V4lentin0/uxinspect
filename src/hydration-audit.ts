import type { Page, ConsoleMessage } from 'playwright';

export interface HydrationIssue {
  kind:
    | 'framework-warning'
    | 'dom-mismatch'
    | 'hydration-failure'
    | 'suspense-boundary-error'
    | 'unexpected-reflow';
  framework?: string;
  message: string;
  stack?: string;
  selector?: string;
}

export interface HydrationAuditResult {
  page: string;
  frameworkDetected: string[];
  issues: HydrationIssue[];
  domSnapshotSize: {
    serverBytes: number;
    clientBytes: number;
    deltaBytes: number;
  };
  passed: boolean;
}

interface PatternRule {
  pattern: RegExp;
  framework: string;
  kind: HydrationIssue['kind'];
}

const PATTERN_RULES: PatternRule[] = [
  {
    pattern: /Hydration failed because/i,
    framework: 'react',
    kind: 'hydration-failure',
  },
  {
    pattern: /Text content does not match server-rendered HTML/i,
    framework: 'react',
    kind: 'dom-mismatch',
  },
  {
    pattern: /did not match\.\s*Server:/i,
    framework: 'react',
    kind: 'dom-mismatch',
  },
  {
    pattern: /Warning:\s*Expected server HTML/i,
    framework: 'react',
    kind: 'framework-warning',
  },
  {
    pattern: /There was an error while hydrating/i,
    framework: 'react',
    kind: 'hydration-failure',
  },
  {
    pattern: /while hydrating.*Suspense boundary/i,
    framework: 'react',
    kind: 'suspense-boundary-error',
  },
  {
    pattern: /Text content did not match/i,
    framework: 'next',
    kind: 'dom-mismatch',
  },
  {
    pattern: /An unhandled error occurred while hydrating/i,
    framework: 'next',
    kind: 'hydration-failure',
  },
  {
    pattern: /Hydration completed but contains mismatches/i,
    framework: 'vue',
    kind: 'framework-warning',
  },
  {
    pattern: /Hydration children mismatch/i,
    framework: 'vue',
    kind: 'dom-mismatch',
  },
  {
    pattern: /Hydration node mismatch/i,
    framework: 'vue',
    kind: 'dom-mismatch',
  },
  {
    pattern: /Svelte hydration failed/i,
    framework: 'svelte',
    kind: 'hydration-failure',
  },
  {
    pattern: /Hydration mismatch/i,
    framework: 'svelte',
    kind: 'dom-mismatch',
  },
  {
    pattern: /Hydration completed with errors/i,
    framework: 'solid',
    kind: 'hydration-failure',
  },
  {
    pattern: /Astro\.createContext/i,
    framework: 'astro',
    kind: 'framework-warning',
  },
  {
    pattern: /hydration failed/i,
    framework: 'astro',
    kind: 'hydration-failure',
  },
];

function extractSelector(text: string): string | undefined {
  const tagMatch = text.match(/<([a-zA-Z][a-zA-Z0-9-]*)/);
  if (tagMatch && tagMatch[1]) return tagMatch[1].toLowerCase();
  const selMatch = text.match(/selector[:\s]+["']([^"']+)["']/i);
  if (selMatch && selMatch[1]) return selMatch[1];
  return undefined;
}

function matchRule(text: string): PatternRule | null {
  for (const rule of PATTERN_RULES) {
    if (rule.pattern.test(text)) return rule;
  }
  return null;
}

interface FrameworkProbeResult {
  frameworks: string[];
}

async function probeFrameworks(page: Page): Promise<FrameworkProbeResult> {
  try {
    return await page.evaluate((): FrameworkProbeResult => {
      const w = window as unknown as Record<string, unknown>;
      const found = new Set<string>();

      if (
        w['__REACT_DEVTOOLS_GLOBAL_HOOK__'] !== undefined ||
        document.querySelector('[data-reactroot]') !== null ||
        document.querySelector('#__next') !== null ||
        document.querySelector('#root') !== null
      ) {
        found.add('react');
      }

      if (w['__NEXT_DATA__'] !== undefined || document.querySelector('#__next') !== null) {
        found.add('next');
      }

      if (w['__NUXT__'] !== undefined || document.querySelector('#__nuxt') !== null) {
        found.add('nuxt');
      }

      const appEl = document.querySelector('[data-v-app], #app');
      if (
        w['__VUE__'] !== undefined ||
        (appEl !== null &&
          (appEl as unknown as { __vue__?: unknown }).__vue__ !== undefined)
      ) {
        found.add('vue');
      }

      if (
        document.querySelector('[data-svelte-h]') !== null ||
        w['__SvelteKit'] !== undefined ||
        w['__sveltekit_dev'] !== undefined
      ) {
        found.add('svelte');
      }

      if (document.querySelector('astro-island') !== null) {
        found.add('astro');
      }

      if (
        document.querySelector('[ng-version]') !== null ||
        w['ng'] !== undefined
      ) {
        found.add('angular');
      }

      if (w['_$HY'] !== undefined) {
        found.add('solid');
      }

      return { frameworks: [...found] };
    });
  } catch {
    return { frameworks: [] };
  }
}

function toStack(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack;
  if (value && typeof value === 'object' && 'stack' in value) {
    const s = (value as { stack?: unknown }).stack;
    return typeof s === 'string' ? s : undefined;
  }
  return undefined;
}

async function readConsoleArgsStack(msg: ConsoleMessage): Promise<string | undefined> {
  try {
    const args = msg.args();
    for (const arg of args) {
      const handle = await arg.getProperty('stack').catch(() => null);
      if (!handle) continue;
      const raw: unknown = await handle.jsonValue().catch(() => undefined);
      const stack = toStack(raw);
      if (stack) return stack;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function bytesOf(html: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(html).length;
  }
  return Buffer.byteLength(html, 'utf8');
}

export async function auditHydration(page: Page): Promise<HydrationAuditResult> {
  const issues: HydrationIssue[] = [];
  const seen = new Set<string>();

  const pushIssue = (issue: HydrationIssue): void => {
    const key = `${issue.kind}|${issue.framework ?? ''}|${issue.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(issue);
  };

  const pendingStacks: Promise<void>[] = [];

  const onConsole = (msg: ConsoleMessage): void => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    const text = msg.text();
    const rule = matchRule(text);
    if (!rule) return;
    const selector = extractSelector(text);
    const framework = rule.framework;
    const kind = rule.kind;
    const base: HydrationIssue = {
      kind,
      framework,
      message: text,
      selector,
    };
    pendingStacks.push(
      (async (): Promise<void> => {
        const stack = await readConsoleArgsStack(msg);
        if (stack) base.stack = stack;
        pushIssue(base);
      })(),
    );
  };

  const onPageError = (err: Error): void => {
    const text = err.message || String(err);
    const rule = matchRule(text);
    if (!rule) return;
    pushIssue({
      kind: rule.kind,
      framework: rule.framework,
      message: text,
      stack: err.stack,
      selector: extractSelector(text),
    });
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);

  let serverBytes = 0;
  try {
    await page.waitForLoadState('domcontentloaded');
    const serverHtml = await page.content();
    serverBytes = bytesOf(serverHtml);
  } catch {
    serverBytes = 0;
  }

  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  } catch {
    /* continue even if networkidle times out */
  }

  let clientBytes = 0;
  try {
    const clientHtml = await page.content();
    clientBytes = bytesOf(clientHtml);
  } catch {
    clientBytes = 0;
  }

  const deltaBytes = clientBytes - serverBytes;
  if (
    serverBytes > 0 &&
    deltaBytes > 0 &&
    deltaBytes / serverBytes > 0.2
  ) {
    pushIssue({
      kind: 'unexpected-reflow',
      message: `Client DOM grew by ${deltaBytes} bytes (${Math.round(
        (deltaBytes / serverBytes) * 100,
      )}%) after networkidle, indicating significant client-side re-render.`,
    });
  }

  const probe = await probeFrameworks(page);

  await Promise.all(pendingStacks);

  page.off('console', onConsole);
  page.off('pageerror', onPageError);

  return {
    page: page.url(),
    frameworkDetected: probe.frameworks,
    issues,
    domSnapshotSize: {
      serverBytes,
      clientBytes,
      deltaBytes,
    },
    passed: issues.length === 0,
  };
}
