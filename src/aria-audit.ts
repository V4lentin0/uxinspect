import type { Page } from 'playwright';

export type AriaIssueType =
  | 'invalid-role'
  | 'abstract-role'
  | 'role-on-wrong-element'
  | 'aria-hidden-on-focusable'
  | 'empty-button'
  | 'empty-link'
  | 'missing-name-on-widget'
  | 'duplicate-id'
  | 'tabindex-gt-zero'
  | 'presentational-with-content'
  | 'invalid-aria-attr';

export interface AriaIssue {
  type: AriaIssueType;
  target: string;
  detail: string;
}

export interface AriaLandmarkCount {
  role: string;
  count: number;
}

export interface AriaAuditResult {
  page: string;
  issues: AriaIssue[];
  landmarks: AriaLandmarkCount[];
  rolesUsed: Record<string, number>;
  passed: boolean;
}

interface AriaEvaluation {
  issues: AriaIssue[];
  landmarks: AriaLandmarkCount[];
  rolesUsed: Record<string, number>;
}

export async function auditAria(page: Page): Promise<AriaAuditResult> {
  const url = page.url();

  const data: AriaEvaluation = await page.evaluate((): AriaEvaluation => {
    const VALID_ROLES: ReadonlySet<string> = new Set([
      'alert',
      'alertdialog',
      'application',
      'article',
      'banner',
      'button',
      'cell',
      'checkbox',
      'columnheader',
      'combobox',
      'complementary',
      'contentinfo',
      'definition',
      'dialog',
      'directory',
      'document',
      'feed',
      'figure',
      'form',
      'grid',
      'gridcell',
      'group',
      'heading',
      'img',
      'link',
      'list',
      'listbox',
      'listitem',
      'log',
      'main',
      'marquee',
      'math',
      'menu',
      'menubar',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'navigation',
      'none',
      'note',
      'option',
      'presentation',
      'progressbar',
      'radio',
      'radiogroup',
      'region',
      'row',
      'rowgroup',
      'rowheader',
      'scrollbar',
      'search',
      'searchbox',
      'separator',
      'slider',
      'spinbutton',
      'status',
      'switch',
      'tab',
      'table',
      'tablist',
      'tabpanel',
      'term',
      'textbox',
      'timer',
      'toolbar',
      'tooltip',
      'tree',
      'treegrid',
      'treeitem',
    ]);

    const ABSTRACT_ROLES: ReadonlySet<string> = new Set([
      'command',
      'composite',
      'input',
      'landmark',
      'range',
      'roletype',
      'section',
      'sectionhead',
      'select',
      'structure',
      'widget',
      'window',
    ]);

    const WIDGET_ROLES: ReadonlySet<string> = new Set([
      'button',
      'checkbox',
      'combobox',
      'link',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'option',
      'radio',
      'slider',
      'spinbutton',
      'switch',
      'tab',
      'textbox',
      'treeitem',
    ]);

    const LANDMARK_ROLES: ReadonlySet<string> = new Set([
      'banner',
      'complementary',
      'contentinfo',
      'form',
      'main',
      'navigation',
      'region',
      'search',
    ]);

    const VALID_ARIA_ATTRS: ReadonlySet<string> = new Set([
      'aria-activedescendant',
      'aria-atomic',
      'aria-autocomplete',
      'aria-busy',
      'aria-checked',
      'aria-colcount',
      'aria-colindex',
      'aria-colspan',
      'aria-controls',
      'aria-current',
      'aria-describedby',
      'aria-details',
      'aria-disabled',
      'aria-dropeffect',
      'aria-errormessage',
      'aria-expanded',
      'aria-flowto',
      'aria-grabbed',
      'aria-haspopup',
      'aria-hidden',
      'aria-invalid',
      'aria-keyshortcuts',
      'aria-label',
      'aria-labelledby',
      'aria-level',
      'aria-live',
      'aria-modal',
      'aria-multiline',
      'aria-multiselectable',
      'aria-orientation',
      'aria-owns',
      'aria-placeholder',
      'aria-posinset',
      'aria-pressed',
      'aria-readonly',
      'aria-relevant',
      'aria-required',
      'aria-roledescription',
      'aria-rowcount',
      'aria-rowindex',
      'aria-rowspan',
      'aria-selected',
      'aria-setsize',
      'aria-sort',
      'aria-valuemax',
      'aria-valuemin',
      'aria-valuenow',
      'aria-valuetext',
    ]);

    const shortSelector = (el: Element): string => {
      let s = el.tagName.toLowerCase();
      if (el.id) s += `#${el.id}`;
      const firstClass = el.classList?.[0];
      if (firstClass) s += `.${firstClass}`;
      return s;
    };

    const isNaturallyFocusable = (el: Element): boolean => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'a' && el.hasAttribute('href')) return true;
      if (tag === 'button') return true;
      if (tag === 'input') {
        const type = (el.getAttribute('type') || '').toLowerCase();
        return type !== 'hidden';
      }
      if (tag === 'select' || tag === 'textarea') return true;
      return false;
    };

    const hasFocusableTabindex = (el: Element): boolean => {
      const ti = el.getAttribute('tabindex');
      if (ti === null) return false;
      const n = parseInt(ti, 10);
      return Number.isFinite(n) && n >= 0;
    };

    const getAccessibleName = (el: Element): string => {
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

      const labelledby = el.getAttribute('aria-labelledby');
      if (labelledby) {
        const ids = labelledby.trim().split(/\s+/);
        const parts: string[] = [];
        for (const id of ids) {
          const ref = document.getElementById(id);
          if (ref) {
            const t = (ref.textContent || '').trim();
            if (t) parts.push(t);
          }
        }
        const joined = parts.join(' ').trim();
        if (joined) return joined;
      }

      const title = el.getAttribute('title');
      if (title && title.trim()) return title.trim();

      const text = (el.textContent || '').trim();
      if (text) return text;

      return '';
    };

    const issues: AriaIssue[] = [];
    const rolesUsed: Record<string, number> = {};
    const landmarkCounts: Record<string, number> = {
      banner: 0,
      complementary: 0,
      contentinfo: 0,
      form: 0,
      main: 0,
      navigation: 0,
      region: 0,
      search: 0,
    };

    const all = document.querySelectorAll('*');

    // 6. duplicate-id (once per id)
    const idMap = new Map<string, number>();
    const reportedDuplicates = new Set<string>();
    all.forEach((el) => {
      const id = el.getAttribute('id');
      if (!id) return;
      idMap.set(id, (idMap.get(id) || 0) + 1);
    });
    idMap.forEach((count, id) => {
      if (count > 1 && !reportedDuplicates.has(id)) {
        reportedDuplicates.add(id);
        const first = document.querySelector(`[id="${CSS.escape(id)}"]`);
        issues.push({
          type: 'duplicate-id',
          target: first ? shortSelector(first) : `[id="${id}"]`,
          detail: `id "${id}" is used ${count} times`,
        });
      }
    });

    all.forEach((el) => {
      const tag = el.tagName.toLowerCase();
      const role = (el.getAttribute('role') || '').trim().toLowerCase();

      // Track roles (explicit)
      if (role) {
        const firstToken = role.split(/\s+/)[0] || role;
        rolesUsed[firstToken] = (rolesUsed[firstToken] || 0) + 1;

        // 1. invalid-role
        if (!VALID_ROLES.has(firstToken) && !ABSTRACT_ROLES.has(firstToken)) {
          issues.push({
            type: 'invalid-role',
            target: shortSelector(el),
            detail: `role="${firstToken}" is not a valid ARIA role`,
          });
        }

        // 2. abstract-role
        if (ABSTRACT_ROLES.has(firstToken)) {
          issues.push({
            type: 'abstract-role',
            target: shortSelector(el),
            detail: `role="${firstToken}" is an abstract role and must not be used`,
          });
        }
      }

      const effectiveRole = role.split(/\s+/)[0] || '';

      // 3. aria-hidden on focusable
      if (el.getAttribute('aria-hidden') === 'true') {
        if (hasFocusableTabindex(el) || isNaturallyFocusable(el)) {
          issues.push({
            type: 'aria-hidden-on-focusable',
            target: shortSelector(el),
            detail: `aria-hidden="true" on focusable ${tag} element`,
          });
        }
      }

      // 4. empty-button / empty-link
      const isButton = tag === 'button' || effectiveRole === 'button';
      const isLink = (tag === 'a' && el.hasAttribute('href')) || effectiveRole === 'link';
      if (isButton || isLink) {
        const text = (el.textContent || '').trim();
        const hasLabel =
          !!(el.getAttribute('aria-label') && el.getAttribute('aria-label')!.trim()) ||
          !!el.getAttribute('aria-labelledby');
        // also consider <input type="submit"/"button" value>
        let valueText = '';
        if (tag === 'input') {
          const itype = (el.getAttribute('type') || '').toLowerCase();
          if (itype === 'submit' || itype === 'button' || itype === 'reset') {
            valueText = (el.getAttribute('value') || '').trim();
          }
        }
        // also allow an inner <img alt> to count as a name for buttons/links
        let imgAlt = '';
        const innerImg = el.querySelector('img[alt]');
        if (innerImg) imgAlt = (innerImg.getAttribute('alt') || '').trim();

        if (!text && !hasLabel && !valueText && !imgAlt) {
          if (isButton) {
            issues.push({
              type: 'empty-button',
              target: shortSelector(el),
              detail: `button has no accessible text, aria-label, or aria-labelledby`,
            });
          } else if (isLink) {
            issues.push({
              type: 'empty-link',
              target: shortSelector(el),
              detail: `link has no accessible text, aria-label, or aria-labelledby`,
            });
          }
        }
      }

      // 5. missing-name on widget role
      if (effectiveRole && WIDGET_ROLES.has(effectiveRole)) {
        const name = getAccessibleName(el);
        if (!name) {
          // input fields may derive name from associated <label>
          let labelName = '';
          const id = el.getAttribute('id');
          if (id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (lbl) labelName = (lbl.textContent || '').trim();
          }
          if (!labelName) {
            const wrapLabel = el.closest('label');
            if (wrapLabel) labelName = (wrapLabel.textContent || '').trim();
          }
          if (!labelName) {
            issues.push({
              type: 'missing-name-on-widget',
              target: shortSelector(el),
              detail: `widget role="${effectiveRole}" has no accessible name`,
            });
          }
        }
      }

      // 7. tabindex > 0
      const tabindexAttr = el.getAttribute('tabindex');
      if (tabindexAttr !== null) {
        const n = parseInt(tabindexAttr, 10);
        if (Number.isFinite(n) && n > 0) {
          issues.push({
            type: 'tabindex-gt-zero',
            target: shortSelector(el),
            detail: `tabindex="${tabindexAttr}" disrupts natural tab order`,
          });
        }
      }

      // 8. presentational with content
      if (effectiveRole === 'presentation' || effectiveRole === 'none') {
        const text = (el.textContent || '').trim();
        const hasInteractiveChild = !!el.querySelector(
          'a[href], button, input, select, textarea, [tabindex], [role]'
        );
        if (text || hasInteractiveChild) {
          issues.push({
            type: 'presentational-with-content',
            target: shortSelector(el),
            detail: `role="${effectiveRole}" on element with content or interactive descendants`,
          });
        }
      }

      // 9. invalid aria-* attributes
      const attrs = el.attributes;
      for (let i = 0; i < attrs.length; i++) {
        const attr = attrs[i];
        if (!attr) continue;
        const name = attr.name.toLowerCase();
        if (name.startsWith('aria-') && !VALID_ARIA_ATTRS.has(name)) {
          issues.push({
            type: 'invalid-aria-attr',
            target: shortSelector(el),
            detail: `unknown ARIA attribute "${name}"`,
          });
        }
      }

      // Landmarks: explicit role
      if (effectiveRole && LANDMARK_ROLES.has(effectiveRole)) {
        landmarkCounts[effectiveRole] = (landmarkCounts[effectiveRole] || 0) + 1;
      }

      // Landmarks: implicit (only when no explicit role overrides)
      if (!effectiveRole) {
        if (tag === 'header') {
          // banner only when not inside article/section/main/aside/nav
          const inScoped = !!el.closest('article, section, main, aside, nav');
          if (!inScoped) landmarkCounts.banner = (landmarkCounts.banner || 0) + 1;
        } else if (tag === 'footer') {
          const inScoped = !!el.closest('article, section, main, aside, nav');
          if (!inScoped) landmarkCounts.contentinfo = (landmarkCounts.contentinfo || 0) + 1;
        } else if (tag === 'nav') {
          landmarkCounts.navigation = (landmarkCounts.navigation || 0) + 1;
        } else if (tag === 'main') {
          landmarkCounts.main = (landmarkCounts.main || 0) + 1;
        } else if (tag === 'aside') {
          landmarkCounts.complementary = (landmarkCounts.complementary || 0) + 1;
        } else if (tag === 'form') {
          if (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) {
            landmarkCounts.form = (landmarkCounts.form || 0) + 1;
          }
        } else if (tag === 'section') {
          if (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) {
            landmarkCounts.region = (landmarkCounts.region || 0) + 1;
          }
        }
      }
    });

    const landmarks: AriaLandmarkCount[] = Object.keys(landmarkCounts)
      .filter((k) => (landmarkCounts[k] || 0) > 0)
      .map((role) => ({ role, count: landmarkCounts[role] || 0 }));

    return { issues, landmarks, rolesUsed };
  });

  return {
    page: url,
    issues: data.issues,
    landmarks: data.landmarks,
    rolesUsed: data.rolesUsed,
    passed: data.issues.length === 0,
  };
}
