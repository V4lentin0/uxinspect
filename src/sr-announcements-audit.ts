/**
 * P6 #50 — Virtual screen-reader announcements audit.
 *
 * Walks interactive, landmark, and live-region nodes and computes what a
 * screen reader would announce using an approximate AccName 1.2 + ARIA 1.2
 * cascade — no external dependencies.
 *
 * Issues flagged:
 *   missing-accessible-name   — interactive element with no computed name
 *   empty-live-region          — aria-live region whose textContent is empty
 *   role-without-state         — checkbox / switch / menuitem missing required state
 *   button-label-mismatch      — visible text diverges too far from aria-label
 *   landmark-unlabeled         — multiple same-role landmarks with no aria-label
 *   announcement-empty         — full computed announcement resolves to ''
 */
import type { Page } from 'playwright';

export type SrIssueKind =
  | 'missing-accessible-name'
  | 'empty-live-region'
  | 'role-without-state'
  | 'button-label-mismatch'
  | 'landmark-unlabeled'
  | 'announcement-empty';

export interface SrAnnouncement {
  readonly selector: string;
  readonly role: string;
  readonly name: string;
  readonly description?: string;
  readonly states: readonly string[];
  readonly announcement: string;
}

export interface SrIssue {
  readonly kind: SrIssueKind;
  readonly selector: string;
  readonly detail: string;
}

export interface SrAuditOptions {
  readonly maxTargets?: number;
  readonly includeLandmarks?: boolean;
  readonly includeLiveRegions?: boolean;
}

export interface SrAuditResult {
  readonly targetsProbed: number;
  readonly announcements: readonly SrAnnouncement[];
  readonly issues: readonly SrIssue[];
  readonly passed: boolean;
  readonly checkedAt: string;
}

export async function runSrAnnouncementsAudit(
  page: Page,
  opts?: SrAuditOptions,
): Promise<SrAuditResult> {
  const maxTargets = opts?.maxTargets ?? 200;
  const includeLandmarks = opts?.includeLandmarks ?? true;
  const includeLiveRegions = opts?.includeLiveRegions ?? true;

  const rawResults = await page.evaluate(
    (args: { maxTargets: number; includeLandmarks: boolean; includeLiveRegions: boolean }) => {
      // ── Helpers ──────────────────────────────────────────────────────────────

      /** Best unique CSS selector for an element. */
      function selectorFor(el: Element): string {
        const id = el.id;
        if (id) return `#${CSS.escape(id)}`;
        const tid = el.getAttribute('data-testid');
        if (tid) return `[data-testid="${tid}"]`;
        const tag = el.tagName.toLowerCase();
        const all = Array.from(document.querySelectorAll(tag));
        const idx = all.indexOf(el);
        return `${tag}:nth-of-type(${idx + 1})`;
      }

      /** Is the element hidden from the accessibility tree? */
      function isHidden(el: Element): boolean {
        const style = window.getComputedStyle(el as HTMLElement);
        if (style.visibility === 'hidden' || style.display === 'none') return true;
        if (el.getAttribute('aria-hidden') === 'true') return true;
        if ((el as HTMLElement).offsetParent === null && style.position !== 'fixed') return true;
        return false;
      }

      /** Approximate AccName 1.2: aria-labelledby > aria-label > <label for> >
       *  innerText (for buttons/links) > placeholder > title > alt. */
      function computedName(el: Element): string {
        // 1. aria-labelledby
        const lblby = el.getAttribute('aria-labelledby');
        if (lblby) {
          const parts = lblby
            .trim()
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
            .filter(Boolean);
          if (parts.length) return parts.join(' ');
        }

        // 2. aria-label
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel?.trim()) return ariaLabel.trim();

        // 3. <label for="id">
        const elId = el.id;
        if (elId) {
          const lbl = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(elId)}"]`);
          if (lbl?.textContent?.trim()) return lbl.textContent.trim();
        }

        // 4. Wrapping <label>
        const parentLabel = el.closest('label');
        if (parentLabel) {
          // exclude the input's own value from the label text
          const clone = parentLabel.cloneNode(true) as HTMLElement;
          clone.querySelectorAll('input,select,textarea').forEach((n) => n.remove());
          const t = clone.textContent?.trim();
          if (t) return t;
        }

        // 5. innerText for interactive / heading elements
        const tag = el.tagName.toLowerCase();
        const role = computedRole(el);
        const innerTextRoles = new Set([
          'button', 'link', 'menuitem', 'tab', 'option', 'treeitem',
          'heading', 'columnheader', 'rowheader', 'cell', 'gridcell',
        ]);
        if (innerTextRoles.has(role) || ['button', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
          const t = (el as HTMLElement).innerText?.trim();
          if (t) return t;
        }

        // 6. placeholder
        const ph = (el as HTMLInputElement).placeholder;
        if (ph?.trim()) return ph.trim();

        // 7. title
        const title = el.getAttribute('title');
        if (title?.trim()) return title.trim();

        // 8. alt (images embedded in interactive elements)
        if (tag === 'img') {
          const alt = (el as HTMLImageElement).alt;
          if (alt !== undefined) return alt.trim();
        }
        const img = el.querySelector('img[alt]');
        if (img) {
          const alt = img.getAttribute('alt');
          if (alt?.trim()) return alt.trim();
        }

        return '';
      }

      /** Accessible description: aria-describedby text. */
      function computedDescription(el: Element): string | undefined {
        const descBy = el.getAttribute('aria-describedby');
        if (!descBy) return undefined;
        const parts = descBy
          .trim()
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
          .filter(Boolean);
        return parts.length ? parts.join(' ') : undefined;
      }

      /** Map HTML tag + type → ARIA role. Explicit role= wins. */
      function computedRole(el: Element): string {
        const explicit = el.getAttribute('role');
        if (explicit?.trim()) return explicit.trim().split(/\s+/)[0]!;

        const tag = el.tagName.toLowerCase();
        const type = ((el as HTMLInputElement).type ?? '').toLowerCase();

        if (tag === 'button') return 'button';
        if (tag === 'a' && el.hasAttribute('href')) return 'link';
        if (tag === 'a') return 'generic';
        if (tag === 'input') {
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          if (type === 'range') return 'slider';
          if (type === 'submit' || type === 'reset' || type === 'button') return 'button';
          if (type === 'search') return 'searchbox';
          return 'textbox';
        }
        if (tag === 'select') return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'nav') return 'navigation';
        if (tag === 'main') return 'main';
        if (tag === 'aside') return 'complementary';
        if (tag === 'header') return 'banner';
        if (tag === 'footer') return 'contentinfo';
        if (tag === 'form') return 'form';
        if (tag === 'section') return 'region';
        if (tag === 'h1') return 'heading';
        if (tag === 'h2') return 'heading';
        if (tag === 'h3') return 'heading';
        if (tag === 'h4') return 'heading';
        if (tag === 'h5') return 'heading';
        if (tag === 'h6') return 'heading';
        return 'generic';
      }

      /** Collect all relevant aria + native states. */
      function computedStates(el: Element): string[] {
        const states: string[] = [];

        const boolAttr = (name: string, label: string): void => {
          const v = el.getAttribute(name);
          if (v === 'true') states.push(label);
          else if (v === 'false') states.push(`not-${label}`);
        };

        boolAttr('aria-checked', 'checked');
        boolAttr('aria-selected', 'selected');
        boolAttr('aria-expanded', 'expanded');
        boolAttr('aria-pressed', 'pressed');

        const current = el.getAttribute('aria-current');
        if (current && current !== 'false') states.push(`current${current !== 'true' ? `-${current}` : ''}`);

        if (el.getAttribute('aria-disabled') === 'true' || (el as HTMLInputElement).disabled) {
          states.push('disabled');
        }
        if ((el as HTMLInputElement).required) states.push('required');
        if ((el as HTMLInputElement).readOnly) states.push('readonly');

        return states;
      }

      /** Build the announcement string that a SR would speak. */
      function buildAnnouncement(name: string, role: string, states: string[], desc?: string): string {
        const namePart = name || '(unnamed)';
        const descPart = desc ? `, ${desc}` : '';
        const statePart = states.length ? `, ${states.join(', ')}` : '';
        return `${namePart}${descPart}, ${role}${statePart}`;
      }

      /** Levenshtein ratio (0–1) between two strings; 1 = identical. */
      function similarity(a: string, b: string): number {
        const la = a.toLowerCase();
        const lb = b.toLowerCase();
        if (la === lb) return 1;
        const m = la.length, n = lb.length;
        if (m === 0 || n === 0) return 0;
        const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
        for (let i = 1; i <= m; i++) {
          let prev = i;
          for (let j = 1; j <= n; j++) {
            const cur = la[i - 1] === lb[j - 1]
              ? dp[j - 1]!
              : 1 + Math.min(prev, dp[j]!, dp[j - 1]!);
            dp[j - 1] = prev;
            prev = cur;
          }
          dp[n] = prev;
        }
        return 1 - dp[n]! / Math.max(m, n);
      }

      // ── Target collection ──────────────────────────────────────────────────

      const INTERACTIVE_SEL = [
        'button', 'a[href]', 'input', 'select', 'textarea',
        '[role]', '[aria-label]', '[aria-labelledby]',
        '[contenteditable]', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      ].join(', ');

      const LANDMARK_SEL = 'nav, main, aside, header, footer, form, [role="navigation"], [role="main"], [role="complementary"], [role="banner"], [role="contentinfo"], [role="form"], [role="region"], [role="search"]';
      const LIVE_SEL = '[aria-live], [aria-atomic], [role="alert"], [role="status"], [role="log"], [role="marquee"], [role="timer"]';

      const seen = new Set<Element>();
      const targets: Element[] = [];

      const addEl = (el: Element): void => {
        if (seen.has(el) || targets.length >= args.maxTargets) return;
        seen.add(el);
        targets.push(el);
      };

      document.querySelectorAll(INTERACTIVE_SEL).forEach(addEl);
      if (args.includeLandmarks) document.querySelectorAll(LANDMARK_SEL).forEach(addEl);
      if (args.includeLiveRegions) document.querySelectorAll(LIVE_SEL).forEach(addEl);

      // ── Per-target analysis ───────────────────────────────────────────────

      type RawAnnouncement = {
        selector: string;
        role: string;
        name: string;
        description?: string;
        states: string[];
        announcement: string;
        hidden: boolean;
      };

      type RawIssue = {
        kind: string;
        selector: string;
        detail: string;
      };

      const announcements: RawAnnouncement[] = [];
      const issueList: RawIssue[] = [];

      // Track landmark role → selectors for unlabeled-landmark check
      const landmarkMap: Map<string, string[]> = new Map();

      // Roles that REQUIRE a state attribute to be accessible
      const requiresState: Record<string, string> = {
        checkbox: 'aria-checked',
        radio: 'aria-checked',
        switch: 'aria-checked',
        menuitemcheckbox: 'aria-checked',
        menuitemradio: 'aria-checked',
        option: 'aria-selected',
        treeitem: 'aria-expanded',
      };

      // Landmark roles for unlabeled-landmark detection
      const landmarkRoles = new Set([
        'navigation', 'main', 'complementary', 'banner',
        'contentinfo', 'form', 'region', 'search',
      ]);

      for (const el of targets) {
        const sel = selectorFor(el);
        const hidden = isHidden(el);
        const role = computedRole(el);
        const name = computedName(el);
        const description = computedDescription(el);
        const states = computedStates(el);
        const announcement = buildAnnouncement(name, role, states, description);

        announcements.push({ selector: sel, role, name, description, states, announcement, hidden });

        if (hidden) continue; // skip issue checks for hidden elements

        // ── Issue: missing-accessible-name ─────────────────────────────────
        const interactiveRoles = new Set([
          'button', 'link', 'textbox', 'searchbox', 'combobox',
          'listbox', 'checkbox', 'radio', 'slider', 'switch',
          'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab',
          'treeitem', 'option', 'columnheader', 'rowheader',
        ]);
        if (interactiveRoles.has(role) && !name) {
          issueList.push({
            kind: 'missing-accessible-name',
            selector: sel,
            detail: `${role} has no accessible name`,
          });
        }

        // ── Issue: role-without-state ───────────────────────────────────────
        const requiredStateAttr = requiresState[role];
        if (requiredStateAttr) {
          const hasState = el.hasAttribute(requiredStateAttr) ||
            (role === 'checkbox' && (el as HTMLInputElement).type === 'checkbox');
          // For native checkboxes, the browser exposes checked state natively
          const isNativeCheckbox = el.tagName.toLowerCase() === 'input' && (el as HTMLInputElement).type === 'checkbox';
          const isNativeRadio = el.tagName.toLowerCase() === 'input' && (el as HTMLInputElement).type === 'radio';
          if (!hasState && !isNativeCheckbox && !isNativeRadio) {
            issueList.push({
              kind: 'role-without-state',
              selector: sel,
              detail: `role="${role}" requires ${requiredStateAttr} but attribute is absent`,
            });
          }
        }

        // ── Issue: button-label-mismatch ────────────────────────────────────
        if (role === 'button' || role === 'link') {
          const ariaLbl = el.getAttribute('aria-label');
          const visibleText = (el as HTMLElement).innerText?.trim() ?? '';
          if (ariaLbl?.trim() && visibleText) {
            const sim = similarity(ariaLbl.trim(), visibleText);
            if (sim < 0.5) {
              issueList.push({
                kind: 'button-label-mismatch',
                selector: sel,
                detail: `visible text "${visibleText}" vs aria-label "${ariaLbl.trim()}" (similarity ${sim.toFixed(2)})`,
              });
            }
          }
        }

        // ── Issue: empty-live-region ────────────────────────────────────────
        const liveVal = el.getAttribute('aria-live');
        const liveRole = el.getAttribute('role');
        const isLiveRegion = liveVal === 'polite' || liveVal === 'assertive' || liveVal === 'off' ||
          liveRole === 'alert' || liveRole === 'status' || liveRole === 'log';
        if (isLiveRegion && !(el.textContent?.trim())) {
          issueList.push({
            kind: 'empty-live-region',
            selector: sel,
            detail: `aria-live region has no text content at audit time`,
          });
        }

        // ── Issue: announcement-empty ──────────────────────────────────────
        if (!announcement) {
          issueList.push({
            kind: 'announcement-empty',
            selector: sel,
            detail: `full announcement resolves to empty string`,
          });
        }

        // ── Landmark tracking ───────────────────────────────────────────────
        if (landmarkRoles.has(role)) {
          const existing = landmarkMap.get(role) ?? [];
          existing.push(sel);
          landmarkMap.set(role, existing);
        }
      }

      // ── Issue: landmark-unlabeled ─────────────────────────────────────────
      for (const [role, selectors] of landmarkMap.entries()) {
        if (selectors.length > 1) {
          // Check how many lack an accessible label
          const unlabeled = selectors.filter((sel) => {
            const found = targets.find((el) => selectorFor(el) === sel);
            if (!found) return false;
            return !found.getAttribute('aria-label') && !found.getAttribute('aria-labelledby');
          });
          if (unlabeled.length > 1) {
            for (const sel of unlabeled) {
              issueList.push({
                kind: 'landmark-unlabeled',
                selector: sel,
                detail: `multiple ${role} landmarks exist but this one has no aria-label or aria-labelledby`,
              });
            }
          }
        }
      }

      return {
        count: targets.length,
        announcements,
        issues: issueList,
      };
    },
    { maxTargets, includeLandmarks, includeLiveRegions },
  );

  const announcements: SrAnnouncement[] = rawResults.announcements
    .filter((a) => !a.hidden)
    .map((a) => ({
      selector: a.selector,
      role: a.role,
      name: a.name,
      ...(a.description !== undefined ? { description: a.description } : {}),
      states: a.states,
      announcement: a.announcement,
    }));

  const issues: SrIssue[] = rawResults.issues.map((i) => ({
    kind: i.kind as SrIssueKind,
    selector: i.selector,
    detail: i.detail,
  }));

  return {
    targetsProbed: rawResults.count,
    announcements,
    issues,
    passed: issues.length === 0,
    checkedAt: new Date().toISOString(),
  };
}
