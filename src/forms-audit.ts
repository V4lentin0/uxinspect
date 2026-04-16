import type { Page } from 'playwright';

export interface FormFieldIssue {
  level: 'error' | 'warn';
  type:
    | 'missing-label'
    | 'missing-autocomplete'
    | 'missing-inputmode'
    | 'missing-required-indicator'
    | 'password-without-https'
    | 'no-aria-error'
    | 'submit-without-validation'
    | 'missing-name';
  selector: string;
  message: string;
}

export interface FormInfo {
  selector: string;
  method: string;
  action: string;
  fields: number;
  issues: FormFieldIssue[];
  hasSubmitButton: boolean;
}

export interface FormsAuditResult {
  page: string;
  forms: FormInfo[];
  totalIssues: number;
  passed: boolean;
}

export async function auditForms(page: Page): Promise<FormsAuditResult> {
  const url = page.url();

  const forms = await page.evaluate((): Omit<FormInfo, never>[] => {
    const results: Omit<FormInfo, never>[] = [];
    const formEls = document.querySelectorAll('form');

    formEls.forEach((form) => {
      const issues: FormFieldIssue[] = [];

      const formId = form.id ? `#${form.id}` : '';
      const formName = form.name ? `[name="${form.name}"]` : '';
      const formSelector = `form${formId}${formName}`;

      const fieldEls = form.querySelectorAll<HTMLElement>(
        'input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select'
      );

      const hasSubmitButton = !!form.querySelector(
        'input[type=submit], button[type=submit], button:not([type])'
      );

      if (!hasSubmitButton) {
        issues.push({
          level: 'warn',
          type: 'missing-name',
          selector: formSelector,
          message: 'Form has no submit button.',
        });
      }

      const hasNovalidate = form.hasAttribute('novalidate');
      const hasRequiredField = !!form.querySelector('[required]');
      const hasPattern = !!form.querySelector('[pattern]');
      const hasEmailOrUrl = !!form.querySelector('input[type=email], input[type=url]');

      if (!hasNovalidate && !hasRequiredField && !hasPattern && !hasEmailOrUrl) {
        issues.push({
          level: 'warn',
          type: 'submit-without-validation',
          selector: formSelector,
          message: 'Form has no client-side validation (no required, pattern, email/url type, or novalidate).',
        });
      }

      fieldEls.forEach((f) => {
        const el = f as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        const tag = el.tagName.toLowerCase();
        const id = el.id || '';
        const name = (el as HTMLInputElement).name || '';
        const type = ((el as HTMLInputElement).type || '').toLowerCase();

        const fieldSelector = id
          ? `#${id}`
          : name
          ? `[name="${name}"]`
          : tag;

        // missing-label
        const labelByFor = id ? form.querySelector(`label[for="${id}"]`) : null;
        const labelByWrap = el.closest('label');
        const ariaLabel = el.getAttribute('aria-label');
        const ariaLabelledby = el.getAttribute('aria-labelledby');
        const hasLabel = !!(labelByFor || labelByWrap || ariaLabel || ariaLabelledby);
        if (!hasLabel) {
          issues.push({
            level: 'error',
            type: 'missing-label',
            selector: fieldSelector,
            message: `Field <${tag}> has no associated label, aria-label, or aria-labelledby.`,
          });
        }

        // missing-name
        if (!name && !id) {
          issues.push({
            level: 'warn',
            type: 'missing-name',
            selector: fieldSelector,
            message: `Field <${tag}> has no name or id attribute.`,
          });
        }

        // missing-autocomplete
        const autocompleteTypes = ['email', 'tel', 'number', 'url', 'password', 'text'];
        if (autocompleteTypes.includes(type) && !el.getAttribute('autocomplete')) {
          issues.push({
            level: 'warn',
            type: 'missing-autocomplete',
            selector: fieldSelector,
            message: `Field type="${type}" is missing autocomplete attribute.`,
          });
        }

        // missing-inputmode
        if (['tel', 'number', 'email'].includes(type) && !el.getAttribute('inputmode')) {
          issues.push({
            level: 'warn',
            type: 'missing-inputmode',
            selector: fieldSelector,
            message: `Field type="${type}" is missing inputmode attribute.`,
          });
        }

        // missing-required-indicator
        const isRequired = (el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true';
        const hasAriaRequired = el.getAttribute('aria-required') === 'true';
        if (isRequired && !hasAriaRequired) {
          const labelEl = labelByFor || labelByWrap;
          const labelText = labelEl ? labelEl.textContent || '' : ariaLabel || '';
          const labelIndicatesRequired = labelText.includes('*') || /required/i.test(labelText);
          if (!labelIndicatesRequired) {
            issues.push({
              level: 'warn',
              type: 'missing-required-indicator',
              selector: fieldSelector,
              message: `Required field lacks aria-required and label does not contain '*' or 'required'.`,
            });
          }
        }

        // password-without-https
        if (type === 'password' && location.protocol === 'http:') {
          issues.push({
            level: 'error',
            type: 'password-without-https',
            selector: fieldSelector,
            message: `Password field present on non-HTTPS page.`,
          });
        }

        // no-aria-error
        if (el.getAttribute('aria-invalid') === 'true') {
          const describedby = el.getAttribute('aria-describedby');
          let errorElHasContent = false;
          if (describedby) {
            const ids = describedby.trim().split(/\s+/);
            errorElHasContent = ids.some((eid) => {
              const errEl = document.getElementById(eid);
              return errEl && (errEl.textContent || '').trim().length > 0;
            });
          }
          if (!errorElHasContent) {
            issues.push({
              level: 'warn',
              type: 'no-aria-error',
              selector: fieldSelector,
              message: `Field has aria-invalid="true" but no aria-describedby pointing to an element with content.`,
            });
          }
        }
      });

      results.push({
        selector: formSelector,
        method: (form.method || 'get').toUpperCase(),
        action: form.action ? form.action.slice(0, 120) : '',
        fields: fieldEls.length,
        issues,
        hasSubmitButton,
      });
    });

    return results;
  });

  const totalIssues = forms.reduce((sum, f) => sum + f.issues.length, 0);
  const passed = forms.every((f) => f.issues.every((i) => i.level !== 'error'));

  return { page: url, forms, totalIssues, passed };
}

// ---------------------------------------------------------------------------
// Form behaviour cycle auditor
//
// Probes each form's runtime validation: submit empty → expect error appears,
// submit invalid → expect error appears, submit valid → expect error clears.
// Structural checks live in auditForms() above.
// ---------------------------------------------------------------------------

export interface FormBehaviorInfo {
  selector: string;
  emptyShowsError: boolean;
  invalidShowsError: boolean;
  validClearsError: boolean;
  missingBehavior: string[];
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}

export interface FormBehaviorResult {
  page: string;
  forms: FormBehaviorInfo[];
  passed: boolean;
}

interface ProbeTarget {
  formSelector: string;
  submitSelector: string;
  inputSelector: string;
  inputType: string;
  inputTag: string;
  isRequired: boolean;
}

const MAX_FORM_MS = 30_000;
const ERROR_POLL_MS = 250;
// Per-phase wait cap: keeps the overall run comfortably below MAX_FORM_MS even
// when every phase has to exhaust its timeout (worst case ≈ 3 × 2.5s + overhead).
const PHASE_WAIT_MS = 2_500;
const PHASE_MIN_WAIT_MS = 600;

// CSS + ARIA selectors we treat as "validation error shown near the form".
const ERROR_SELECTORS = [
  '[aria-invalid="true"]',
  '[role="alert"]',
  '.error',
  '.invalid',
  '.is-invalid',
  '.has-error',
  '.field-error',
  '.form-error',
  '.error-message',
  '.help-block.error',
  '[data-error="true"]',
];

function invalidValueFor(type: string): string {
  // Intentionally malformed values to trigger native/ARIA validation.
  switch (type) {
    case 'email':
      return 'x';
    case 'url':
      return 'not a url';
    case 'tel':
      return 'abc';
    case 'number':
      return 'abc';
    default:
      return '';
  }
}

function validValueFor(type: string): string {
  switch (type) {
    case 'email':
      return 'test@example.com';
    case 'tel':
      return '+11234567890';
    case 'url':
      return 'https://example.com';
    case 'number':
      return '42';
    case 'password':
      return 'Valid1Password!';
    case 'date':
      return '2025-01-15';
    case 'time':
      return '12:30';
    case 'month':
      return '2025-01';
    case 'week':
      return '2025-W03';
    case 'color':
      return '#336699';
    case 'search':
    case 'text':
    default:
      return 'valid input';
  }
}

export async function auditFormBehavior(
  page: Page,
  formSelector?: string,
): Promise<FormBehaviorResult> {
  const url = page.url();
  const results: FormBehaviorInfo[] = [];

  // Discover probe targets. Runs a single evaluate so we operate on DOM truth
  // at discovery time; probes that follow use Playwright locators by selector.
  const targets: ProbeTarget[] = await page
    .evaluate(
      ({ scopeSelector }: { scopeSelector?: string }) => {
        const cssEscape = (s: string): string => {
          // Simple fallback; CSS.escape exists in all evergreen browsers.
          if ((globalThis as any).CSS?.escape) return (globalThis as any).CSS.escape(s);
          return s.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
        };

        const describe = (el: Element): string => {
          if (el.id) return `#${cssEscape(el.id)}`;
          const name = (el as HTMLInputElement).name;
          if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
          const form = el.closest('form');
          const parent = form ?? document;
          const tag = el.tagName.toLowerCase();
          const siblings = Array.from(parent.querySelectorAll(tag));
          const idx = siblings.indexOf(el);
          return idx >= 0 ? `${tag}:nth-of-type(${idx + 1})` : tag;
        };

        const formEls = scopeSelector
          ? Array.from(document.querySelectorAll(scopeSelector)).filter(
              (el): el is HTMLFormElement => el instanceof HTMLFormElement,
            )
          : Array.from(document.querySelectorAll('form'));

        const found: ProbeTarget[] = [];
        formEls.forEach((form, formIdx) => {
          const submit = form.querySelector<HTMLElement>(
            'button[type=submit], input[type=submit], button:not([type])',
          );
          if (!submit) return;

          const candidate = form.querySelector<HTMLElement>(
            'input[required]:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea[required]',
          ) ||
            form.querySelector<HTMLElement>(
              'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea',
            );
          if (!candidate) return;

          const formSel =
            (form.id && `form#${cssEscape(form.id)}`) ||
            (form.getAttribute('name') && `form[name="${form.getAttribute('name')}"]`) ||
            `form:nth-of-type(${formIdx + 1})`;

          const inputType = ((candidate as HTMLInputElement).type || candidate.tagName.toLowerCase())
            .toLowerCase();
          const inputTag = candidate.tagName.toLowerCase();

          const inputSel = `${formSel} ${describe(candidate)}`;
          const submitSel = `${formSel} ${describe(submit)}`;

          found.push({
            formSelector: formSel,
            submitSelector: submitSel,
            inputSelector: inputSel,
            inputType,
            inputTag,
            isRequired: (candidate as HTMLInputElement).required === true,
          });
        });
        return found;
      },
      { scopeSelector: formSelector },
    )
    .catch((): ProbeTarget[] => []);

  for (const t of targets) {
    const info: FormBehaviorInfo = {
      selector: t.formSelector,
      emptyShowsError: false,
      invalidShowsError: false,
      validClearsError: false,
      missingBehavior: [],
    };

    const started = Date.now();
    const budgetLeft = () => Math.max(0, MAX_FORM_MS - (Date.now() - started));

    try {
      await page.waitForTimeout(0);

      // Step 1: empty submit
      await clearInput(page, t.inputSelector);
      await suppressNativePopup(page, t.formSelector);
      const submitClicked1 = await submitForm(page, t);
      if (!submitClicked1) {
        info.error = 'submit-click-failed';
        info.missingBehavior.push('submit-click-failed');
        results.push(info);
        continue;
      }
      info.emptyShowsError = await waitForError(
        page,
        t.formSelector,
        t.inputSelector,
        PHASE_MIN_WAIT_MS,
        Math.min(PHASE_WAIT_MS, budgetLeft()),
      );
      if (!info.emptyShowsError) info.missingBehavior.push('no-error-on-empty-submit');

      // Step 2: invalid submit
      const invalidVal = invalidValueFor(t.inputType);
      if (invalidVal.length > 0) {
        await fillInput(page, t.inputSelector, invalidVal);
        const submitClicked2 = await submitForm(page, t);
        if (submitClicked2) {
          info.invalidShowsError = await waitForError(
            page,
            t.formSelector,
            t.inputSelector,
            PHASE_MIN_WAIT_MS,
            Math.min(PHASE_WAIT_MS, budgetLeft()),
          );
          if (!info.invalidShowsError) info.missingBehavior.push('no-error-on-invalid-submit');
        }
      } else {
        // Skip invalid phase for types without a usable invalid value.
        info.invalidShowsError = info.emptyShowsError;
      }

      // Step 3: valid submit — error should clear.
      await clearInput(page, t.inputSelector);
      await fillInput(page, t.inputSelector, validValueFor(t.inputType));
      // Freeze navigation so we can observe post-submit DOM before it unloads.
      await preventSubmitNavigation(page, t.formSelector);
      await submitForm(page, t);
      info.validClearsError = await waitForErrorCleared(
        page,
        t.formSelector,
        t.inputSelector,
        PHASE_MIN_WAIT_MS,
        Math.min(PHASE_WAIT_MS, budgetLeft()),
      );
      if (!info.validClearsError) info.missingBehavior.push('error-persists-on-valid-submit');
    } catch (e) {
      info.error = (e as Error)?.message ?? String(e);
    }

    results.push(info);
  }

  const passed = results.every(
    (r) => r.missingBehavior.length === 0 && !r.error,
  );
  return { page: url, forms: results, passed };
}

async function clearInput(page: Page, selector: string): Promise<void> {
  try {
    await page.fill(selector, '', { timeout: 1000 });
  } catch {
    // ignore — non-fillable field
  }
}

async function fillInput(page: Page, selector: string, value: string): Promise<void> {
  try {
    await page.fill(selector, value, { timeout: 1500 });
  } catch {
    // fall back to type if fill is unsupported for the field type
    try {
      await page.locator(selector).first().type(value, { timeout: 1500 });
    } catch {
      // give up silently; waitForError will report the absence
    }
  }
}

async function submitForm(page: Page, t: ProbeTarget): Promise<boolean> {
  try {
    await page.click(t.submitSelector, { timeout: 1500 });
    return true;
  } catch {
    try {
      await page.locator(t.formSelector).evaluate((form: Element) => {
        if (form instanceof HTMLFormElement) {
          form.requestSubmit?.();
        }
      });
      return true;
    } catch {
      return false;
    }
  }
}

async function suppressNativePopup(page: Page, formSelector: string): Promise<void> {
  // Some forms rely on the native `invalid` event + popup bubble. We stop the
  // popup to make sure the probe observes DOM state, not browser chrome.
  await page
    .evaluate((sel: string) => {
      const form = document.querySelector(sel);
      if (!form || !(form instanceof HTMLFormElement)) return;
      form.addEventListener(
        'invalid',
        (ev) => {
          // Don't preventDefault — we want aria-invalid & :invalid state set —
          // but cancel the popup via capture-phase listener on the field.
        },
        true,
      );
      Array.from(form.elements).forEach((el) => {
        el.addEventListener(
          'invalid',
          (ev) => {
            ev.preventDefault();
          },
          true,
        );
      });
    }, formSelector)
    .catch(() => {});
}

async function preventSubmitNavigation(page: Page, formSelector: string): Promise<void> {
  await page
    .evaluate((sel: string) => {
      const form = document.querySelector(sel);
      if (!form || !(form instanceof HTMLFormElement)) return;
      form.addEventListener(
        'submit',
        (ev) => {
          // Only neutralise navigation if the form would actually submit.
          if (!ev.defaultPrevented) ev.preventDefault();
        },
        { capture: true },
      );
    }, formSelector)
    .catch(() => {});
}

async function hasError(
  page: Page,
  formSelector: string,
  inputSelector: string,
): Promise<boolean> {
  return page
    .evaluate(
      ({ formSel, inputSel, errSelectors }: {
        formSel: string;
        inputSel: string;
        errSelectors: string[];
      }) => {
        const form = document.querySelector(formSel);
        if (!form) return false;
        const input = document.querySelector(inputSel);

        // 1. aria-invalid on the probed input.
        if (input?.getAttribute('aria-invalid') === 'true') return true;

        // (Native `:invalid` / `input.validity.valid` is NOT counted here —
        //  we suppressed the native popup, so that state carries no
        //  user-visible signal. Broken forms that rely solely on native
        //  constraint validation must still be flagged as missing behavior.)

        // 2. error selector inside the form.
        for (const sel of errSelectors) {
          const matches = Array.from(form.querySelectorAll(sel));
          for (const m of matches) {
            const text = (m.textContent || '').trim();
            // Any visible error node with non-empty text qualifies; aria-invalid
            // matches even without text (the attr itself is the signal).
            if (sel === '[aria-invalid="true"]' || text.length > 0) return true;
          }
        }

        // 4. error selector right after the form (e.g. sibling alert).
        const next = form.nextElementSibling;
        if (next) {
          for (const sel of errSelectors) {
            if (next.matches(sel)) return true;
          }
        }

        // 5. aria-describedby points to an element with visible text.
        if (input) {
          const describedBy = input.getAttribute('aria-describedby');
          if (describedBy) {
            const ids = describedBy.trim().split(/\s+/);
            for (const id of ids) {
              const el = document.getElementById(id);
              if (el && (el.textContent || '').trim().length > 0) return true;
            }
          }
        }
        return false;
      },
      { formSel: formSelector, inputSel: inputSelector, errSelectors: ERROR_SELECTORS },
    )
    .catch(() => false);
}

async function waitForError(
  page: Page,
  formSelector: string,
  inputSelector: string,
  minWaitMs: number,
  budgetMs: number,
): Promise<boolean> {
  await page.waitForTimeout(Math.min(minWaitMs, budgetMs));
  if (await hasError(page, formSelector, inputSelector)) return true;
  const deadline = Date.now() + Math.max(0, budgetMs - minWaitMs);
  while (Date.now() < deadline) {
    await page.waitForTimeout(ERROR_POLL_MS);
    if (await hasError(page, formSelector, inputSelector)) return true;
  }
  return false;
}

async function waitForErrorCleared(
  page: Page,
  formSelector: string,
  inputSelector: string,
  minWaitMs: number,
  budgetMs: number,
): Promise<boolean> {
  await page.waitForTimeout(Math.min(minWaitMs, budgetMs));
  if (!(await hasError(page, formSelector, inputSelector))) return true;
  const deadline = Date.now() + Math.max(0, budgetMs - minWaitMs);
  while (Date.now() < deadline) {
    await page.waitForTimeout(ERROR_POLL_MS);
    if (!(await hasError(page, formSelector, inputSelector))) return true;
  }
  return false;
}
