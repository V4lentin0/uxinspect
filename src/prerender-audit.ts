import type { Page } from 'playwright';

export type PrerenderIssueType =
  | 'csr-only'
  | 'empty-noscript-shell'
  | 'hydration-mismatch-risk'
  | 'missing-h1-in-raw'
  | 'missing-main-in-raw';

export interface PrerenderIssue {
  type: PrerenderIssueType;
  detail: string;
}

export interface PrerenderAuditResult {
  page: string;
  rawHtmlSize: number;
  hydratedHtmlSize: number;
  textVisibleInRaw: number;
  textVisibleAfterHydration: number;
  textRatio: number;
  framework?: string;
  isSPA: boolean;
  rawHasH1: boolean;
  rawHasMain: boolean;
  issues: PrerenderIssue[];
  passed: boolean;
}

interface HydratedProbe {
  framework?: string;
  hasH1: boolean;
  hasMain: boolean;
}

const TAG_STRIP_REGEX = /<[^>]*>/g;
const H1_REGEX = /<h1[\s>]/i;
const MAIN_REGEX = /<main[\s>]/i;
const ROLE_MAIN_REGEX = /role\s*=\s*["']?main["']?/i;
const NOSCRIPT_REGEX = /<noscript[\s>][\s\S]*?<\/noscript>/i;
const NOSCRIPT_BODY_REGEX = /<noscript[\s>]([\s\S]*?)<\/noscript>/i;

function countVisibleText(html: string): number {
  if (!html) return 0;
  const stripped = html.replace(TAG_STRIP_REGEX, ' ');
  return stripped.trim().length;
}

function rawContainsH1(html: string): boolean {
  return H1_REGEX.test(html);
}

function rawContainsMain(html: string): boolean {
  return MAIN_REGEX.test(html) || ROLE_MAIN_REGEX.test(html);
}

function noscriptHasUsefulMessage(html: string): boolean {
  const match = html.match(NOSCRIPT_BODY_REGEX);
  if (!match) return false;
  const inner = match[1] ?? '';
  const innerText = inner.replace(TAG_STRIP_REGEX, ' ').trim();
  return innerText.length >= 30;
}

async function fetchRawHtml(page: Page): Promise<string | null> {
  try {
    const response = await page.context().request.get(page.url(), {
      failOnStatusCode: false,
    });
    const body = await response.text();
    return body;
  } catch {
    return null;
  }
}

async function probeHydratedPage(page: Page): Promise<HydratedProbe> {
  try {
    return await page.evaluate((): HydratedProbe => {
      const w = window as unknown as Record<string, unknown>;
      let framework: string | undefined;

      if (
        w['React'] !== undefined ||
        document.querySelector('[data-reactroot]') !== null ||
        w['__REACT_DEVTOOLS_GLOBAL_HOOK__'] !== undefined
      ) {
        framework = 'react';
      }

      if (w['__NUXT__'] !== undefined) {
        framework = 'nuxt';
      }

      if (w['__NEXT_DATA__'] !== undefined) {
        framework = 'next';
      }

      if (w['ng'] !== undefined || document.querySelector('[ng-version]') !== null) {
        framework = 'angular';
      }

      if (
        document.querySelector('[data-v-app]') !== null ||
        w['__VUE__'] !== undefined
      ) {
        framework = framework ?? 'vue';
      }

      if (framework === undefined) {
        if (w['Svelte'] !== undefined) {
          framework = 'svelte';
        } else {
          const scripts = document.querySelectorAll('script');
          for (let i = 0; i < scripts.length; i++) {
            const text = scripts[i].textContent ?? '';
            if (text.includes('svelte')) {
              framework = 'svelte';
              break;
            }
          }
        }
      }

      const hasH1 = document.querySelector('h1') !== null;
      const hasMain =
        document.querySelector('main') !== null ||
        document.querySelector('[role="main"]') !== null;

      return { framework, hasH1, hasMain };
    });
  } catch {
    return { framework: undefined, hasH1: false, hasMain: false };
  }
}

export async function auditPrerender(page: Page): Promise<PrerenderAuditResult> {
  const pageUrl = page.url();

  const rawHtml = await fetchRawHtml(page);
  const hasRaw = rawHtml !== null;
  const rawHtmlSize = hasRaw ? rawHtml.length : 0;

  let hydratedHtml = '';
  try {
    hydratedHtml = await page.content();
  } catch {
    hydratedHtml = '';
  }
  const hydratedHtmlSize = hydratedHtml.length;

  const textVisibleInRaw = hasRaw ? countVisibleText(rawHtml) : 0;
  const textVisibleAfterHydration = countVisibleText(hydratedHtml);

  const rawHasH1 = hasRaw ? rawContainsH1(rawHtml) : false;
  const rawHasMain = hasRaw ? rawContainsMain(rawHtml) : false;

  const probe = await probeHydratedPage(page);
  const framework = probe.framework;

  const isSPA =
    hasRaw && textVisibleInRaw < 200 && textVisibleAfterHydration > 200;

  const denom = Math.max(textVisibleAfterHydration, 1);
  const textRatio = hasRaw ? textVisibleInRaw / denom : 0;

  const issues: PrerenderIssue[] = [];

  if (isSPA && framework !== undefined) {
    issues.push({
      type: 'csr-only',
      detail: `Page appears to be client-rendered (${framework}): raw HTML has ${textVisibleInRaw} chars of visible text, hydrated has ${textVisibleAfterHydration}`,
    });
  }

  if (hasRaw && NOSCRIPT_REGEX.test(rawHtml) && textVisibleAfterHydration > textVisibleInRaw * 10) {
    if (!noscriptHasUsefulMessage(rawHtml)) {
      issues.push({
        type: 'empty-noscript-shell',
        detail:
          '<noscript> block exists but contains no useful message for users with JavaScript disabled',
      });
    }
  }

  if (hasRaw && !rawHasH1 && probe.hasH1) {
    issues.push({
      type: 'missing-h1-in-raw',
      detail: 'Rendered page has <h1> but raw server HTML does not — SEO crawlers may miss it',
    });
  }

  if (hasRaw && !rawHasMain && probe.hasMain) {
    issues.push({
      type: 'missing-main-in-raw',
      detail:
        'Rendered page has <main> landmark but raw server HTML does not — accessibility/SEO impact',
    });
  }

  if (hasRaw && textRatio < 0.2 && textVisibleAfterHydration > 500) {
    issues.push({
      type: 'hydration-mismatch-risk',
      detail: `Raw-to-hydrated text ratio is ${textRatio.toFixed(3)} (raw ${textVisibleInRaw}, hydrated ${textVisibleAfterHydration}) — SSR appears incomplete`,
    });
  }

  const passed = !issues.some((i) => i.type === 'csr-only');

  return {
    page: pageUrl,
    rawHtmlSize,
    hydratedHtmlSize,
    textVisibleInRaw,
    textVisibleAfterHydration,
    textRatio,
    framework,
    isSPA,
    rawHasH1,
    rawHasMain,
    issues,
    passed,
  };
}
