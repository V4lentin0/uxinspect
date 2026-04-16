/**
 * P6 #48 — XSS payload filler.
 *
 * Walks every text-like input / textarea / contenteditable on the page,
 * types a battery of known XSS payloads, triggers the surrounding form's
 * submit (or an adjacent button) and reports:
 *   - executed: the payload set `window.__uxinspectXssExec` (strongest
 *     signal — code ran).
 *   - reflectedUnescaped: the raw payload appeared in the rendered DOM as
 *     live HTML (script/img/iframe/etc.) rather than as escaped text —
 *     means the site interpolated user input into innerHTML unsafely.
 *   - page-error: a pageerror mentioning our marker fired (weaker signal
 *     that an injection attempt reached a live parser).
 *
 * The audit is DOM-level: we never submit over the network. That makes it
 * safe to run against any page and catches the common unsafe-HTML-sink
 * class of bug in React / Vue / server-rendered templates.
 */
import type { Page } from 'playwright';

/** Types of DOM sink that matter for XSS. */
export type XssSinkType = 'input' | 'textarea' | 'contenteditable';

/** One interactive field we tried to abuse. */
export interface XssField {
  readonly selector: string;
  readonly sinkType: XssSinkType;
  readonly name?: string;
}

export type XssIssueKind = 'executed' | 'reflected-unescaped' | 'page-error';

export interface XssIssue {
  readonly kind: XssIssueKind;
  readonly field: XssField;
  readonly payload: string;
  readonly detail?: string;
}

export interface XssAuditResult {
  readonly fieldsProbed: number;
  readonly payloadsPerField: number;
  readonly issues: readonly XssIssue[];
  readonly passed: boolean;
}

export interface XssAuditOptions {
  /** Cap how many fields we probe (defense against huge forms). Default 25. */
  readonly maxFields?: number;
  /** Wait N ms after submit before inspecting the DOM. Default 150. */
  readonly settleMs?: number;
  /** Override the payload list. */
  readonly payloads?: readonly string[];
  /** Skip selectors whose `name`/`id`/`placeholder` match these substrings (case-insensitive). */
  readonly skip?: readonly string[];
}

/**
 * Canonical payload set. A unique marker (`UXI_XSS_{n}`) lets us tell
 * reflected input apart from arbitrary on-page text.
 */
export const DEFAULT_XSS_PAYLOADS: readonly string[] = [
  '<script>window.__uxinspectXssExec=(window.__uxinspectXssExec||0)+1;/*UXI_XSS_1*/</script>',
  '<img src=x onerror="window.__uxinspectXssExec=(window.__uxinspectXssExec||0)+1;/*UXI_XSS_2*/">',
  '"><svg onload="window.__uxinspectXssExec=(window.__uxinspectXssExec||0)+1;/*UXI_XSS_3*/">',
  'javascript:window.__uxinspectXssExec=(window.__uxinspectXssExec||0)+1;/*UXI_XSS_4*/',
  '<iframe srcdoc="<script>parent.__uxinspectXssExec=(parent.__uxinspectXssExec||0)+1;/*UXI_XSS_5*/</script>"></iframe>',
];

/** Patterns that match the raw payload strings as live HTML on the page. */
const RAW_INTERPRETABLE_SIGNATURES: readonly RegExp[] = [
  /<script\b[^>]*>[\s\S]*?UXI_XSS_\d/i,
  /<img\s+[^>]*onerror\s*=\s*["'][^"']*UXI_XSS_\d/i,
  /<svg\s+[^>]*onload\s*=\s*["'][^"']*UXI_XSS_\d/i,
  /<iframe\s+[^>]*srcdoc\s*=\s*["'][^"']*UXI_XSS_\d/i,
];

export async function runXssAudit(
  page: Page,
  opts: XssAuditOptions = {},
): Promise<XssAuditResult> {
  const maxFields = opts.maxFields ?? 25;
  const settleMs = opts.settleMs ?? 150;
  const payloads = opts.payloads ?? DEFAULT_XSS_PAYLOADS;
  const skip = (opts.skip ?? []).map((s) => s.toLowerCase());

  // Reset exec counter + install pageerror listener.
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__uxinspectXssExec = 0;
  });
  const pageErrors: string[] = [];
  const onPageError = (err: Error): void => {
    pageErrors.push(err.message);
  };
  page.on('pageerror', onPageError);

  // Discover fields. We read name/id/placeholder so skip-lists are ergonomic.
  const fields = await page.evaluate((cap) => {
    const matches = (s?: string | null): boolean => typeof s === 'string' && s.length > 0;
    const out: { selector: string; sinkType: 'input' | 'textarea' | 'contenteditable'; name?: string }[] = [];
    const textInputs = document.querySelectorAll<HTMLInputElement>(
      'input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input:not([type])',
    );
    const textareas = document.querySelectorAll<HTMLTextAreaElement>('textarea');
    const ce = document.querySelectorAll<HTMLElement>('[contenteditable="true"], [contenteditable=""]');
    const pushField = (
      el: Element,
      sinkType: 'input' | 'textarea' | 'contenteditable',
      name?: string,
    ): void => {
      if (out.length >= cap) return;
      const id = (el as HTMLElement).id;
      const htmlName = (el as HTMLInputElement | HTMLTextAreaElement).name;
      const tid = (el as HTMLElement).getAttribute('data-testid') ?? undefined;
      let selector: string;
      if (matches(id)) selector = `#${CSS.escape(id)}`;
      else if (matches(htmlName)) selector = `${el.tagName.toLowerCase()}[name="${htmlName}"]`;
      else if (matches(tid)) selector = `[data-testid="${tid}"]`;
      else {
        const all = Array.from(document.querySelectorAll(el.tagName.toLowerCase()));
        const idx = all.indexOf(el as Element);
        selector = `${el.tagName.toLowerCase()}:nth-of-type(${idx + 1})`;
      }
      out.push({ selector, sinkType, name });
    };
    textInputs.forEach((el) => pushField(el, 'input', el.name || el.id || el.placeholder));
    textareas.forEach((el) => pushField(el, 'textarea', el.name || el.id));
    ce.forEach((el) => pushField(el, 'contenteditable', el.id));
    return out;
  }, maxFields);

  const filtered = fields.filter(
    (f) => !skip.some((s) => (f.name ?? '').toLowerCase().includes(s) || f.selector.toLowerCase().includes(s)),
  );

  const issues: XssIssue[] = [];

  for (const field of filtered) {
    for (const payload of payloads) {
      // Reset marker + errors per payload so we can attribute them.
      await page.evaluate(() => {
        (window as unknown as Record<string, unknown>).__uxinspectXssExec = 0;
      });
      pageErrors.length = 0;

      try {
        if (field.sinkType === 'contenteditable') {
          // innerText avoids Playwright's text-node escaping so we can see
          // whether the page itself re-parses the content.
          await page.evaluate(
            (args: { sel: string; p: string }) => {
              const el = document.querySelector(args.sel);
              if (!el) return;
              (el as HTMLElement).innerText = args.p;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('blur', { bubbles: true }));
            },
            { sel: field.selector, p: payload },
          );
        } else {
          await page.fill(field.selector, payload);
          await page.evaluate((sel: string) => {
            const el = document.querySelector(sel);
            if (!el) return;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
          }, field.selector);
        }
      } catch {
        continue;
      }

      // Try to submit the surrounding form so server-template sinks fire.
      // preventDefault on submit so the page does not navigate.
      await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return;
        const form = (el as HTMLInputElement).form;
        if (form) {
          const handler = (e: Event): void => e.preventDefault();
          form.addEventListener('submit', handler, { once: true });
          form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        }
      }, field.selector);

      await page.waitForTimeout(settleMs);

      // Did code actually execute?
      const exec = await page.evaluate(
        () => (window as unknown as Record<string, number>).__uxinspectXssExec ?? 0,
      );
      if (exec > 0) {
        issues.push({ kind: 'executed', field, payload, detail: `exec count ${exec}` });
        continue;
      }

      // Is the payload reflected as live HTML?
      const bodyHtml = await page.evaluate(() => document.body.innerHTML);
      const match = RAW_INTERPRETABLE_SIGNATURES.find((rx) => rx.test(bodyHtml));
      if (match) {
        issues.push({
          kind: 'reflected-unescaped',
          field,
          payload,
          detail: `matched ${match}`,
        });
        continue;
      }

      // Did a pageerror mention our marker?
      const err = pageErrors.find((m) => /UXI_XSS_\d/.test(m));
      if (err) {
        issues.push({ kind: 'page-error', field, payload, detail: err });
      }
    }
  }

  page.off('pageerror', onPageError);

  return {
    fieldsProbed: filtered.length,
    payloadsPerField: payloads.length,
    issues,
    passed: issues.length === 0,
  };
}
