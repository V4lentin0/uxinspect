import type { Page } from 'playwright';

export type SvgIssueType =
  | 'missing-title'
  | 'missing-role'
  | 'decorative-without-aria-hidden'
  | 'title-not-first-child'
  | 'desc-without-title'
  | 'focusable-without-tabindex'
  | 'missing-xmlns'
  | 'inaccessible-icon'
  | 'currentcolor-not-inherited'
  | 'viewbox-missing';

export interface SvgIssue {
  type: SvgIssueType;
  severity: 'info' | 'warn' | 'error';
  selector: string;
  detail: string;
  snippet?: string;
}

export interface SvgAuditResult {
  page: string;
  svgCount: number;
  decorativeCount: number;
  accessibleCount: number;
  inaccessibleCount: number;
  issues: SvgIssue[];
  passed: boolean;
}

interface SvgEvaluation {
  svgCount: number;
  decorativeCount: number;
  accessibleCount: number;
  inaccessibleCount: number;
  issues: SvgIssue[];
}

export async function auditSvgs(page: Page): Promise<SvgAuditResult> {
  const url = page.url();

  const data: SvgEvaluation = await page.evaluate((): SvgEvaluation => {
    type LocalIssueType =
      | 'missing-title'
      | 'missing-role'
      | 'decorative-without-aria-hidden'
      | 'title-not-first-child'
      | 'desc-without-title'
      | 'focusable-without-tabindex'
      | 'missing-xmlns'
      | 'inaccessible-icon'
      | 'currentcolor-not-inherited'
      | 'viewbox-missing';

    interface LocalIssue {
      type: LocalIssueType;
      severity: 'info' | 'warn' | 'error';
      selector: string;
      detail: string;
      snippet?: string;
    }

    function buildSelector(el: Element): string {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const testid = el.getAttribute('data-testid');
      if (testid) return `[data-testid="${testid}"]`;
      const tag = el.tagName.toLowerCase();
      const classes = Array.from(el.classList).slice(0, 3);
      if (classes.length) return `${tag}.${classes.map((c) => CSS.escape(c)).join('.')}`;
      const parent = el.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((s) => s.tagName === el.tagName);
        if (sibs.length > 1) return `${tag}:nth-of-type(${sibs.indexOf(el) + 1})`;
      }
      return tag;
    }

    function snippetOf(el: Element): string {
      const html = el.outerHTML || '';
      return html.length > 120 ? `${html.slice(0, 117)}...` : html;
    }

    function trimText(el: Element | null | undefined): string {
      return el ? (el.textContent || '').trim() : '';
    }

    function firstElChild(el: Element): Element | null {
      for (const c of Array.from(el.childNodes)) {
        if (c.nodeType === 1) return c as Element;
        if (c.nodeType === 3 && (c.textContent || '').trim().length > 0) return null;
      }
      return null;
    }

    function directChild(el: Element, name: string): Element | null {
      for (const c of Array.from(el.children)) if (c.localName === name) return c;
      return null;
    }

    function ancestorName(svg: SVGElement): string {
      let node: Element | null = svg.parentElement;
      while (node && node !== document.body) {
        const tag = node.tagName.toLowerCase();
        const role = node.getAttribute('role');
        const clickable =
          tag === 'button' || tag === 'a' || role === 'button' || role === 'link' ||
          node.hasAttribute('onclick');
        if (clickable) {
          const aria = (node.getAttribute('aria-label') || '').trim();
          if (aria) return aria;
          const lb = node.getAttribute('aria-labelledby');
          if (lb) {
            const t = trimText(document.getElementById(lb));
            if (t) return t;
          }
          const title = (node.getAttribute('title') || '').trim();
          if (title) return title;
          const clone = node.cloneNode(true) as Element;
          clone.querySelectorAll('svg').forEach((s) => s.remove());
          return (clone.textContent || '').trim();
        }
        node = node.parentElement;
      }
      return 'NOT_INTERACTIVE';
    }

    function inAncestorRoleImg(svg: SVGElement): boolean {
      let node: Element | null = svg.parentElement;
      while (node && node !== document.body) {
        if (node.getAttribute('role') === 'img') return true;
        node = node.parentElement;
      }
      return false;
    }

    function hasSize(svg: SVGElement): boolean {
      if (svg.getAttribute('width') && svg.getAttribute('height')) return true;
      const r = svg.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    function isHardcoded(v: string | null): boolean {
      if (!v) return false;
      const t = v.trim().toLowerCase();
      if (t === 'currentcolor' || t === 'none' || t === 'inherit' || t === 'transparent') return false;
      return /^#[0-9a-f]{3,8}$/i.test(t) || t.startsWith('rgb') || t.startsWith('hsl');
    }

    const svgEls = Array.from(document.querySelectorAll('svg')) as SVGElement[];
    const issues: LocalIssue[] = [];
    let decorativeCount = 0;
    let accessibleCount = 0;
    let inaccessibleCount = 0;
    let colorIssues = 0;

    for (const svg of svgEls) {
      const selector = buildSelector(svg);
      const snippet = snippetOf(svg);
      const ariaHidden = svg.getAttribute('aria-hidden') === 'true';
      const role = svg.getAttribute('role');
      const presentational = role === 'presentation' || role === 'none';
      const ariaLabel = (svg.getAttribute('aria-label') || '').trim();
      const ariaLabelledby = (svg.getAttribute('aria-labelledby') || '').trim();
      const titleEl = directChild(svg, 'title');
      const descEl = directChild(svg, 'desc');
      const titleText = trimText(titleEl);
      const hasName = !!(ariaLabel || ariaLabelledby || titleText);
      const isEmpty = svg.children.length === 0;
      const decorative = ariaHidden || presentational || (isEmpty && !hasName);
      const ancestorImg = inAncestorRoleImg(svg);

      if (decorative) decorativeCount++;
      else if (hasName || ancestorImg) accessibleCount++;
      else inaccessibleCount++;

      if (!decorative && !hasName && !ancestorImg) {
        issues.push({
          type: 'missing-title', severity: 'error', selector,
          detail: 'svg has no <title>, aria-label, or aria-labelledby', snippet,
        });
      }
      if (!decorative && !ancestorImg && hasName && role !== 'img') {
        issues.push({
          type: 'missing-role', severity: 'warn', selector,
          detail: `meaningful svg should have role="img" (current role: ${role || 'none'})`,
          snippet,
        });
      }
      if (isEmpty && !hasName && !ariaHidden && !presentational) {
        issues.push({
          type: 'decorative-without-aria-hidden', severity: 'warn', selector,
          detail: 'empty svg with no accessible name should have aria-hidden="true"', snippet,
        });
      }
      if (titleEl && firstElChild(svg) !== titleEl) {
        issues.push({
          type: 'title-not-first-child', severity: 'info', selector,
          detail: '<title> must be the first child of <svg> for SR support', snippet,
        });
      }
      if (descEl && !titleEl) {
        issues.push({
          type: 'desc-without-title', severity: 'warn', selector,
          detail: '<desc> present without a <title> sibling', snippet,
        });
      }
      if (svg.getAttribute('focusable') === 'true' && !svg.hasAttribute('tabindex')) {
        issues.push({
          type: 'focusable-without-tabindex', severity: 'info', selector,
          detail: 'focusable="true" without tabindex is inconsistent across browsers', snippet,
        });
      }
      if (!svg.getAttribute('xmlns')) {
        issues.push({
          type: 'missing-xmlns', severity: 'info', selector,
          detail: 'inline svg should declare xmlns="http://www.w3.org/2000/svg"', snippet,
        });
      }
      if (colorIssues < 10) {
        const fillAttr = svg.getAttribute('fill');
        const strokeAttr = svg.getAttribute('stroke');
        if (isHardcoded(fillAttr) || isHardcoded(strokeAttr)) {
          issues.push({
            type: 'currentcolor-not-inherited', severity: 'info', selector,
            detail: `root color hardcoded (fill="${fillAttr || ''}" stroke="${strokeAttr || ''}"); use currentColor to inherit`,
            snippet,
          });
          colorIssues++;
        }
      }
      if (!svg.hasAttribute('viewBox') && hasSize(svg)) {
        issues.push({
          type: 'viewbox-missing', severity: 'info', selector,
          detail: 'sized svg without viewBox does not scale responsively', snippet,
        });
      }
      if (!decorative) {
        const an = ancestorName(svg);
        if (an !== 'NOT_INTERACTIVE' && an === '' && !hasName) {
          issues.push({
            type: 'inaccessible-icon', severity: 'error', selector,
            detail: 'svg used as icon inside clickable element with no accessible name',
            snippet,
          });
        }
      }
    }

    return {
      svgCount: svgEls.length,
      decorativeCount,
      accessibleCount,
      inaccessibleCount,
      issues,
    };
  });

  const passed = data.issues.every((i) => i.severity !== 'error');

  return {
    page: url,
    svgCount: data.svgCount,
    decorativeCount: data.decorativeCount,
    accessibleCount: data.accessibleCount,
    inaccessibleCount: data.inaccessibleCount,
    issues: data.issues,
    passed,
  };
}
