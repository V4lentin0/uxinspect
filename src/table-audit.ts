import type { Page } from 'playwright';

export type TableIssueType =
  | 'no-caption'
  | 'no-th'
  | 'th-without-scope'
  | 'empty-th'
  | 'layout-table-with-semantics'
  | 'nested-table'
  | 'merged-cells-complex'
  | 'missing-headers-attr'
  | 'duplicate-th-text'
  | 'table-role-overridden'
  | 'no-summary-for-complex'
  | 'colgroup-without-scope';

export interface TableIssue {
  type: TableIssueType;
  severity: 'info' | 'warn' | 'error';
  selector: string;
  detail: string;
}

export interface TableAuditResult {
  page: string;
  tableCount: number;
  dataTableCount: number;
  layoutTableCount: number;
  issues: TableIssue[];
  passed: boolean;
}

interface TableEvaluation {
  tableCount: number;
  dataTableCount: number;
  layoutTableCount: number;
  issues: TableIssue[];
}

export async function auditTables(page: Page): Promise<TableAuditResult> {
  const url = page.url();

  const data: TableEvaluation = await page.evaluate((): TableEvaluation => {
    const VALID_SCOPES: ReadonlySet<string> = new Set(['row', 'col', 'rowgroup', 'colgroup']);

    const buildSelector = (el: Element): string => {
      const parts: string[] = [];
      let cur: Element | null = el;
      for (let d = 0; cur && d < 4; d++) {
        const tag = cur.tagName.toLowerCase();
        const parent: Element | null = cur.parentElement;
        if (parent) {
          const sibs = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
          parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${sibs.indexOf(cur) + 1})` : tag);
        } else parts.unshift(tag);
        cur = parent;
      }
      return parts.join(' > ');
    };

    const norm = (s: string | null | undefined): string =>
      (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

    const spanGt1 = (el: Element, attr: 'rowspan' | 'colspan'): boolean => {
      const n = parseInt(el.getAttribute(attr) || '1', 10);
      return Number.isFinite(n) && n > 1;
    };

    const isLayoutTable = (table: HTMLTableElement): boolean => {
      const role = (table.getAttribute('role') || '').trim().toLowerCase();
      if (role === 'presentation' || role === 'none') return true;
      const hasTh = table.querySelector('th') !== null;
      const hasCaption = table.querySelector(':scope > caption') !== null;
      const hasThead = table.querySelector(':scope > thead') !== null;
      const rowCount = table.querySelectorAll('tr').length;
      return !hasTh && !hasCaption && !hasThead && rowCount <= 2;
    };

    const issues: TableIssue[] = [];
    const tables = Array.from(document.querySelectorAll('table'));
    let dataTableCount = 0;
    let layoutTableCount = 0;
    const push = (
      type: TableIssueType,
      severity: 'info' | 'warn' | 'error',
      selector: string,
      detail: string
    ): void => void issues.push({ type, severity, selector, detail });

    for (const table of tables) {
      const sel = buildSelector(table);
      const role = (table.getAttribute('role') || '').trim().toLowerCase();
      const layout = isLayoutTable(table);

      if (layout) {
        layoutTableCount++;
        if (table.querySelector('th') || table.querySelector(':scope > caption')) {
          push(
            'layout-table-with-semantics',
            'warn',
            sel,
            'table marked as layout (role=presentation/none) but contains th or caption'
          );
        }
        continue;
      }

      dataTableCount++;

      if (role && role !== 'table' && role !== 'grid' && role !== 'treegrid') {
        push(
          'table-role-overridden',
          'warn',
          sel,
          `table element has role="${role}" which overrides native table semantics`
        );
      }

      const captionEl = table.querySelector(':scope > caption');
      if (!captionEl) {
        push('no-caption', 'warn', sel, 'data table has no <caption> element');
      } else if (table.firstElementChild !== captionEl) {
        push('no-caption', 'warn', sel, '<caption> must be the first child of <table>');
      }

      const ths = Array.from(table.querySelectorAll('th'));
      if (ths.length === 0) {
        push('no-th', 'error', sel, 'data table has no <th> header cells');
      }

      for (const th of ths) {
        const thSel = buildSelector(th);
        const scope = (th.getAttribute('scope') || '').trim().toLowerCase();
        const text = (th.textContent || '').trim();
        const hasLabel =
          (th.getAttribute('aria-label') || '').trim().length > 0 ||
          (th.getAttribute('aria-labelledby') || '').trim().length > 0;

        if (!text && !hasLabel) {
          push('empty-th', 'error', thSel, '<th> has no text content or accessible label');
        }
        if (!scope) {
          push(
            'th-without-scope',
            'warn',
            thSel,
            '<th> missing scope attribute (row|col|rowgroup|colgroup)'
          );
        } else if (!VALID_SCOPES.has(scope)) {
          push('th-without-scope', 'warn', thSel, `<th> has invalid scope="${scope}"`);
        }
      }

      for (const cg of Array.from(table.querySelectorAll(':scope > colgroup'))) {
        for (const th of Array.from(cg.querySelectorAll('th'))) {
          const sc = (th.getAttribute('scope') || '').trim().toLowerCase();
          if (sc !== 'colgroup' && sc !== 'col') {
            push(
              'colgroup-without-scope',
              'warn',
              buildSelector(th),
              '<th> in <colgroup> should have scope="colgroup" or scope="col"'
            );
          }
        }
      }

      const cells = Array.from(table.querySelectorAll('td, th'));
      const hasComplexSpan = cells.some((c) => spanGt1(c, 'rowspan') || spanGt1(c, 'colspan'));

      if (hasComplexSpan) {
        const spannedTds = Array.from(table.querySelectorAll('td')).filter(
          (td) => spanGt1(td, 'rowspan') || spanGt1(td, 'colspan')
        );
        const headerIds = new Set<string>();
        for (const th of ths) {
          const id = th.getAttribute('id');
          if (id) headerIds.add(id);
        }
        let missing = 0;
        for (const td of spannedTds) {
          const ha = (td.getAttribute('headers') || '').trim();
          if (!ha) {
            missing++;
            continue;
          }
          if (!ha.split(/\s+/).every((r) => headerIds.has(r))) missing++;
        }
        if (missing > 0) {
          push(
            'missing-headers-attr',
            'error',
            sel,
            `${missing} merged cell(s) missing valid headers attribute referencing th[id]`
          );
          push(
            'merged-cells-complex',
            'warn',
            sel,
            'table uses rowspan/colspan but lacks headers attribute association'
          );
        }
      }

      const nested = table.querySelectorAll('td table, th table');
      if (nested.length > 0) {
        push('nested-table', 'warn', sel, `${nested.length} nested table(s) found inside this table`);
      }

      const rows = Array.from(
        table.querySelectorAll(':scope > thead > tr, :scope > tbody > tr, :scope > tr')
      );

      const seenRowDup = new Set<string>();
      for (const row of rows) {
        const counts = new Map<string, number>();
        for (const th of Array.from(row.querySelectorAll(':scope > th'))) {
          const t = norm(th.textContent);
          if (t) counts.set(t, (counts.get(t) || 0) + 1);
        }
        counts.forEach((count, text) => {
          const key = `r:${text}`;
          if (count > 1 && !seenRowDup.has(key)) {
            seenRowDup.add(key);
            push(
              'duplicate-th-text',
              'info',
              buildSelector(row),
              `header text "${text}" appears ${count} times in same row`
            );
          }
        });
      }

      const colTexts = new Map<number, string[]>();
      for (const row of rows) {
        let col = 0;
        for (const cell of Array.from(row.children).filter(
          (c) => c.tagName === 'TH' || c.tagName === 'TD'
        )) {
          if (cell.tagName === 'TH') {
            const scope = (cell.getAttribute('scope') || '').trim().toLowerCase();
            if (scope === 'col' || scope === '') {
              const t = norm(cell.textContent);
              if (t) {
                const arr = colTexts.get(col) || [];
                arr.push(t);
                colTexts.set(col, arr);
              }
            }
          }
          const cs = parseInt(cell.getAttribute('colspan') || '1', 10);
          col += Number.isFinite(cs) && cs > 0 ? cs : 1;
        }
      }
      const seenColDup = new Set<string>();
      colTexts.forEach((texts, idx) => {
        const counts = new Map<string, number>();
        for (const t of texts) counts.set(t, (counts.get(t) || 0) + 1);
        counts.forEach((count, text) => {
          const key = `c:${idx}:${text}`;
          if (count > 1 && !seenColDup.has(key)) {
            seenColDup.add(key);
            push(
              'duplicate-th-text',
              'info',
              sel,
              `header text "${text}" appears ${count} times in column ${idx + 1}`
            );
          }
        });
      });

      if (rows.length > 20) {
        const hasDesc = (table.getAttribute('aria-describedby') || '').trim().length > 0;
        const hasAL = (table.getAttribute('aria-label') || '').trim().length > 0;
        if (!captionEl && !hasDesc && !hasAL) {
          push(
            'no-summary-for-complex',
            'info',
            sel,
            `large table (${rows.length} rows) lacks <caption>, aria-label, or aria-describedby`
          );
        }
      }
    }

    return { tableCount: tables.length, dataTableCount, layoutTableCount, issues };
  });

  return {
    page: url,
    tableCount: data.tableCount,
    dataTableCount: data.dataTableCount,
    layoutTableCount: data.layoutTableCount,
    issues: data.issues,
    passed: data.issues.every((i) => i.severity !== 'error'),
  };
}
