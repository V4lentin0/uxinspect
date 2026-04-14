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
