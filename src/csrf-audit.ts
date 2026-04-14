import type { Page, BrowserContext, Cookie } from 'playwright';

export interface FormCsrfState {
  selector: string;
  action: string;
  method: string;
  hasCsrfField: boolean;
  csrfFieldName?: string;
  csrfFieldValue?: string;
  metaCsrfPresent: boolean;
  cookieSameSite: 'Strict' | 'Lax' | 'None' | 'missing';
  isIdempotent: boolean;
  isCrossOrigin: boolean;
  passed: boolean;
}

export interface CsrfIssue {
  kind:
    | 'form-missing-csrf'
    | 'csrf-header-missing'
    | 'samesite-none-no-csrf'
    | 'weak-csrf-entropy'
    | 'csrf-in-url';
  selector?: string;
  detail: string;
}

export interface CsrfAuditResult {
  page: string;
  forms: FormCsrfState[];
  metaCsrfToken: string | null;
  cookieDefenses: { sameSiteStrict: number; sameSiteLax: number; sameSiteNone: number };
  issues: CsrfIssue[];
  passed: boolean;
}

interface RawFormData {
  selector: string;
  action: string;
  method: string;
  csrfFieldName: string | null;
  csrfFieldValue: string | null;
  actionQueryCsrf: boolean;
}

interface PageProbe {
  forms: RawFormData[];
  metaCsrfToken: string | null;
  inlineScriptHasCsrfHeader: boolean;
  inlineScriptUsesFetch: boolean;
  pageUrlHasCsrf: boolean;
}

const CSRF_COOKIE_NAMES = new Set(['csrftoken', '_csrf', 'XSRF-TOKEN']);

function redactValue(raw: string): string {
  if (raw.length <= 8) return '***';
  return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
}

function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const total = value.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function normalizeSameSite(v: Cookie['sameSite']): 'Strict' | 'Lax' | 'None' | undefined {
  return v === 'Strict' || v === 'Lax' || v === 'None' ? v : undefined;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function urlHasCsrfParam(url: string): boolean {
  try {
    const parsed = new URL(url);
    for (const key of parsed.searchParams.keys()) {
      if (/csrf|_token|authenticity_token|xsrf/i.test(key)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function probePage(page: Page): Promise<PageProbe> {
  return page.evaluate(() => {
    const namePattern = /csrf|_token|authenticity_token|xsrf/i;
    const headerPattern = /['"]x-csrf-token['"]|['"]x-xsrf-token['"]|['"]csrf-token['"]/i;
    const fetchUsagePattern = /\bfetch\s*\(|XMLHttpRequest|axios/;

    function buildSelector(form: HTMLFormElement, index: number): string {
      if (form.id) return `form#${form.id}`;
      const name = form.getAttribute('name');
      if (name) return `form[name="${name}"]`;
      const action = form.getAttribute('action');
      if (action) return `form[action="${action}"]`;
      return `form:nth-of-type(${index + 1})`;
    }

    function paramHasCsrf(raw: string): boolean {
      try {
        const parsed = new URL(raw, document.baseURI);
        for (const k of parsed.searchParams.keys()) {
          if (namePattern.test(k)) return true;
        }
        return false;
      } catch {
        return false;
      }
    }

    const formEls = Array.from(document.querySelectorAll('form'));
    const forms: RawFormData[] = formEls.map((form, index) => {
      const fe = form as HTMLFormElement;
      const actionRaw = fe.getAttribute('action') ?? '';
      let action = actionRaw;
      try {
        action = new URL(actionRaw || document.URL, document.baseURI).href;
      } catch {
        action = actionRaw;
      }
      const method = (fe.getAttribute('method') ?? 'get').toLowerCase();
      const inputs = Array.from(fe.querySelectorAll<HTMLInputElement>('input[name]'));
      let csrfFieldName: string | null = null;
      let csrfFieldValue: string | null = null;
      for (const input of inputs) {
        const n = input.getAttribute('name') ?? '';
        if (namePattern.test(n)) {
          csrfFieldName = n;
          csrfFieldValue = input.value ?? '';
          break;
        }
      }
      return {
        selector: buildSelector(fe, index),
        action,
        method,
        csrfFieldName,
        csrfFieldValue,
        actionQueryCsrf: paramHasCsrf(actionRaw || document.URL),
      };
    });

    const metaEl = document.querySelector(
      'meta[name="csrf-token"], meta[name="_csrf"], meta[name="x-csrf-token"]'
    );
    const metaCsrfToken = metaEl?.getAttribute('content') ?? null;

    const scriptEls = Array.from(document.querySelectorAll('script:not([src])'));
    let inlineScriptHasCsrfHeader = false;
    let inlineScriptUsesFetch = false;
    for (const script of scriptEls) {
      const text = script.textContent ?? '';
      if (headerPattern.test(text)) inlineScriptHasCsrfHeader = true;
      if (fetchUsagePattern.test(text)) inlineScriptUsesFetch = true;
    }

    return {
      forms,
      metaCsrfToken,
      inlineScriptHasCsrfHeader,
      inlineScriptUsesFetch,
      pageUrlHasCsrf: paramHasCsrf(document.URL),
    };
  });
}

function countSameSite(cookies: Cookie[]): CsrfAuditResult['cookieDefenses'] {
  let sameSiteStrict = 0;
  let sameSiteLax = 0;
  let sameSiteNone = 0;
  for (const c of cookies) {
    const ss = normalizeSameSite(c.sameSite);
    if (ss === 'Strict') sameSiteStrict += 1;
    else if (ss === 'Lax') sameSiteLax += 1;
    else if (ss === 'None') sameSiteNone += 1;
  }
  return { sameSiteStrict, sameSiteLax, sameSiteNone };
}

function dominantSameSite(cookies: Cookie[]): 'Strict' | 'Lax' | 'None' | 'missing' {
  let strict = 0;
  let lax = 0;
  let none = 0;
  let explicit = 0;
  for (const c of cookies) {
    const ss = normalizeSameSite(c.sameSite);
    if (ss === undefined) continue;
    explicit += 1;
    if (ss === 'Strict') strict += 1;
    else if (ss === 'Lax') lax += 1;
    else if (ss === 'None') none += 1;
  }
  if (explicit === 0) return 'missing';
  if (strict >= lax && strict >= none) return 'Strict';
  if (lax >= none) return 'Lax';
  return 'None';
}

function hasCsrfCookie(cookies: Cookie[]): boolean {
  for (const c of cookies) if (CSRF_COOKIE_NAMES.has(c.name)) return true;
  return false;
}

function buildFormState(
  raw: RawFormData,
  pageOrigin: string | null,
  metaPresent: boolean,
  cookieSameSite: 'Strict' | 'Lax' | 'None' | 'missing'
): FormCsrfState {
  const isIdempotent = raw.method === 'get' || raw.method === 'head';
  const actionOrigin = originOf(raw.action);
  const isCrossOrigin =
    actionOrigin !== null && pageOrigin !== null && actionOrigin !== pageOrigin;
  const hasCsrfField = raw.csrfFieldName !== null;
  const protectedForm =
    isIdempotent || hasCsrfField || metaPresent || cookieSameSite === 'Strict';
  const state: FormCsrfState = {
    selector: raw.selector,
    action: raw.action,
    method: raw.method,
    hasCsrfField,
    metaCsrfPresent: metaPresent,
    cookieSameSite,
    isIdempotent,
    isCrossOrigin,
    passed: protectedForm,
  };
  if (raw.csrfFieldName !== null) state.csrfFieldName = raw.csrfFieldName;
  if (raw.csrfFieldValue !== null && raw.csrfFieldValue.length > 0) {
    state.csrfFieldValue = redactValue(raw.csrfFieldValue);
  }
  return state;
}

function collectFormIssues(raw: RawFormData, state: FormCsrfState): CsrfIssue[] {
  const issues: CsrfIssue[] = [];
  if (
    !state.isIdempotent &&
    !state.hasCsrfField &&
    !state.metaCsrfPresent &&
    state.cookieSameSite !== 'Strict'
  ) {
    issues.push({
      kind: 'form-missing-csrf',
      selector: state.selector,
      detail: `${state.method.toUpperCase()} form has no CSRF token, meta token, or SameSite=Strict cookie`,
    });
  }
  if (
    raw.csrfFieldValue !== null &&
    raw.csrfFieldValue.length > 0 &&
    shannonEntropy(raw.csrfFieldValue) < 3
  ) {
    issues.push({
      kind: 'weak-csrf-entropy',
      selector: state.selector,
      detail: `CSRF field "${raw.csrfFieldName ?? '?'}" has low Shannon entropy (<3 bits/char)`,
    });
  }
  if (raw.actionQueryCsrf) {
    issues.push({
      kind: 'csrf-in-url',
      selector: state.selector,
      detail: 'CSRF-like parameter found in form action query string (leaks via Referer)',
    });
  }
  return issues;
}

export async function auditCsrf(
  page: Page,
  ctx: BrowserContext
): Promise<CsrfAuditResult> {
  const pageUrl = page.url();
  const pageOrigin = originOf(pageUrl);
  const probe = await probePage(page);
  const cookies = await ctx.cookies(pageUrl);
  const cookieDefenses = countSameSite(cookies);
  const cookieSameSite = dominantSameSite(cookies);
  const csrfCookiePresent = hasCsrfCookie(cookies);
  const metaPresent = probe.metaCsrfToken !== null;

  const forms: FormCsrfState[] = probe.forms.map((raw) =>
    buildFormState(raw, pageOrigin, metaPresent, cookieSameSite)
  );

  const issues: CsrfIssue[] = [];
  probe.forms.forEach((raw, index) => {
    const state = forms[index];
    if (!state) return;
    for (const issue of collectFormIssues(raw, state)) issues.push(issue);
  });

  if (
    probe.inlineScriptUsesFetch &&
    !probe.inlineScriptHasCsrfHeader &&
    !metaPresent &&
    !csrfCookiePresent
  ) {
    issues.push({
      kind: 'csrf-header-missing',
      detail:
        'Inline scripts issue fetch/XHR without X-CSRF-Token header and no meta or cookie token is visible',
    });
  }

  if (cookieDefenses.sameSiteNone > 0 && !csrfCookiePresent && !metaPresent) {
    issues.push({
      kind: 'samesite-none-no-csrf',
      detail: `${cookieDefenses.sameSiteNone} cookie(s) use SameSite=None with no CSRF token visible`,
    });
  }

  if (probe.pageUrlHasCsrf || urlHasCsrfParam(pageUrl)) {
    issues.push({
      kind: 'csrf-in-url',
      detail: 'CSRF-like parameter visible in current page URL (leaks via Referer)',
    });
  }

  const passed = issues.length === 0 && forms.every((f) => f.passed);

  return {
    page: pageUrl,
    forms,
    metaCsrfToken: probe.metaCsrfToken,
    cookieDefenses,
    issues,
    passed,
  };
}
