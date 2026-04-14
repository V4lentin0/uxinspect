import type { Page } from 'playwright';

export interface HeadingInfo {
  level: number;
  text: string;
  target: string;
}

export interface HeadingIssue {
  type:
    | 'no-h1'
    | 'multiple-h1'
    | 'skip-level'
    | 'empty-heading'
    | 'heading-out-of-order'
    | 'heading-inside-button';
  detail: string;
  target?: string;
}

export interface HeadingHierarchyResult {
  page: string;
  headings: HeadingInfo[];
  h1Count: number;
  issues: HeadingIssue[];
  passed: boolean;
}

interface CollectedHeading {
  level: number;
  text: string;
  target: string;
  hasAriaLabel: boolean;
  insideButton: boolean;
}

export async function auditHeadings(page: Page): Promise<HeadingHierarchyResult> {
  const url = page.url();

  const collected = await page.evaluate((): CollectedHeading[] => {
    const truncate = (s: string, max: number): string => {
      const trimmed = s.replace(/\s+/g, ' ').trim();
      return trimmed.length > max ? trimmed.slice(0, max - 1) + '\u2026' : trimmed;
    };

    const shortSelector = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      if (el.id) {
        const safeId = el.id.replace(/(["\\])/g, '\\$1');
        return `${tag}#${safeId}`;
      }
      const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
      if (cls.length > 0) {
        return `${tag}.${cls[0]}`;
      }
      const role = el.getAttribute('role');
      if (role) return `${tag}[role="${role}"]`;
      const parent = el.parentElement;
      if (!parent) return tag;
      const siblings = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
      if (siblings.length === 1) return tag;
      const idx = siblings.indexOf(el) + 1;
      return `${tag}:nth-of-type(${idx})`;
    };

    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>(
        'h1, h2, h3, h4, h5, h6, [role="heading"][aria-level]'
      )
    );

    const results: CollectedHeading[] = [];
    for (const el of nodes) {
      const tag = el.tagName.toLowerCase();
      let level: number | null = null;

      const role = el.getAttribute('role');
      if (role === 'heading') {
        const ariaLevel = el.getAttribute('aria-level');
        if (ariaLevel) {
          const parsed = parseInt(ariaLevel, 10);
          if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 6) {
            level = parsed;
          }
        }
      }

      if (level === null && /^h[1-6]$/.test(tag)) {
        level = parseInt(tag.slice(1), 10);
      }

      if (level === null) continue;

      const text = truncate(el.textContent || '', 120);
      const target = shortSelector(el);
      const hasAriaLabel = !!(el.getAttribute('aria-label') || '').trim();

      let insideButton = false;
      let cur: Element | null = el;
      while (cur) {
        const ct = cur.tagName.toLowerCase();
        const cr = cur.getAttribute('role');
        if (ct === 'button' || cr === 'button') {
          insideButton = true;
          break;
        }
        cur = cur.parentElement;
      }

      results.push({ level, text, target, hasAriaLabel, insideButton });
    }

    return results;
  });

  const headings: HeadingInfo[] = collected.map((h) => ({
    level: h.level,
    text: h.text,
    target: h.target,
  }));

  const issues: HeadingIssue[] = [];
  const h1Count = collected.filter((h) => h.level === 1).length;

  if (h1Count === 0) {
    issues.push({ type: 'no-h1', detail: 'Page has no h1 heading.' });
  } else if (h1Count > 1) {
    issues.push({
      type: 'multiple-h1',
      detail: `Page has ${h1Count} h1 headings; expected exactly one.`,
    });
  }

  let prevLevel: number | null = null;
  for (const h of collected) {
    if (h.text.length === 0 && !h.hasAriaLabel) {
      issues.push({
        type: 'empty-heading',
        detail: `Heading h${h.level} has no text content or aria-label.`,
        target: h.target,
      });
    }

    if (h.insideButton) {
      issues.push({
        type: 'heading-inside-button',
        detail: `Heading h${h.level} is nested inside a button, which breaks semantic structure.`,
        target: h.target,
      });
    }

    if (prevLevel !== null && h.level > prevLevel + 1) {
      issues.push({
        type: 'skip-level',
        detail: `Heading jumps from h${prevLevel} to h${h.level} (skipped ${h.level - prevLevel - 1} level(s)).`,
        target: h.target,
      });
    }

    prevLevel = h.level;
  }

  const passed = issues.length === 0;

  return { page: url, headings, h1Count, issues, passed };
}
