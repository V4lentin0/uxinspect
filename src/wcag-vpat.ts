/**
 * P9 #79 — WCAG 2.2 VPAT 2.5 INT generator.
 *
 * Maps a11y findings (as produced by `src/a11y.ts` → `A11yViolation[]`)
 * onto the WCAG 2.2 Success Criteria table used in the VPAT 2.5 INT
 * (International) template. Emits either HTML (suitable for review or
 * direct print) or a PDF produced via Playwright's `page.pdf()`.
 *
 * Enterprise tier only — the CLI wrapper verifies the license plan
 * before calling `generateVpatPdf`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface VpatOptions {
  productName: string;
  productVersion: string;
  contactEmail: string;
  companyName?: string;
  companyAddress?: string;
  logo?: string;
  date?: string;
  /** Optional narrative describing evaluation methodology. */
  evaluationMethods?: string;
}

interface ScMapping {
  sc: string;
  name: string;
  level: 'A' | 'AA';
  /** Substrings in axe rule ids or descriptions that map onto this SC. */
  keywords: string[];
}

/**
 * WCAG 2.2 SC rows included in VPAT 2.5 INT (Level A + AA subset that
 * an automated a11y engine can produce signal on). Manual-review rows
 * are included with empty keyword lists so they always land at
 * `Not Applicable` in purely automated output — human reviewers override
 * this before publishing.
 */
const SC_MAPPINGS: ScMapping[] = [
  // Perceivable
  { sc: '1.1.1', name: 'Non-text Content', level: 'A', keywords: ['image-alt', 'alt', 'input-image-alt', 'area-alt', 'object-alt', 'svg-img-alt'] },
  { sc: '1.2.1', name: 'Audio-only and Video-only (Prerecorded)', level: 'A', keywords: [] },
  { sc: '1.2.2', name: 'Captions (Prerecorded)', level: 'A', keywords: ['video-caption'] },
  { sc: '1.3.1', name: 'Info and Relationships', level: 'A', keywords: ['definition-list', 'dlitem', 'list', 'listitem', 'landmark-one-main', 'heading-order', 'p-as-heading', 'table-duplicate-name', 'td-headers-attr'] },
  { sc: '1.3.2', name: 'Meaningful Sequence', level: 'A', keywords: ['tabindex'] },
  { sc: '1.3.3', name: 'Sensory Characteristics', level: 'A', keywords: [] },
  { sc: '1.3.4', name: 'Orientation', level: 'AA', keywords: [] },
  { sc: '1.3.5', name: 'Identify Input Purpose', level: 'AA', keywords: ['autocomplete-valid'] },
  { sc: '1.4.1', name: 'Use of Color', level: 'A', keywords: ['link-in-text-block'] },
  { sc: '1.4.2', name: 'Audio Control', level: 'A', keywords: ['no-autoplay-audio'] },
  { sc: '1.4.3', name: 'Contrast (Minimum)', level: 'AA', keywords: ['color-contrast'] },
  { sc: '1.4.4', name: 'Resize Text', level: 'AA', keywords: ['meta-viewport'] },
  { sc: '1.4.5', name: 'Images of Text', level: 'AA', keywords: [] },
  { sc: '1.4.10', name: 'Reflow', level: 'AA', keywords: [] },
  { sc: '1.4.11', name: 'Non-text Contrast', level: 'AA', keywords: ['color-contrast', 'focus'] },
  { sc: '1.4.12', name: 'Text Spacing', level: 'AA', keywords: [] },
  { sc: '1.4.13', name: 'Content on Hover or Focus', level: 'AA', keywords: [] },
  // Operable
  { sc: '2.1.1', name: 'Keyboard', level: 'A', keywords: ['keyboard'] },
  { sc: '2.1.2', name: 'No Keyboard Trap', level: 'A', keywords: ['trap'] },
  { sc: '2.1.4', name: 'Character Key Shortcuts', level: 'A', keywords: [] },
  { sc: '2.2.1', name: 'Timing Adjustable', level: 'A', keywords: ['meta-refresh'] },
  { sc: '2.2.2', name: 'Pause, Stop, Hide', level: 'A', keywords: ['blink', 'marquee'] },
  { sc: '2.3.1', name: 'Three Flashes or Below Threshold', level: 'A', keywords: [] },
  { sc: '2.4.1', name: 'Bypass Blocks', level: 'A', keywords: ['bypass', 'skip-link'] },
  { sc: '2.4.2', name: 'Page Titled', level: 'A', keywords: ['document-title'] },
  { sc: '2.4.3', name: 'Focus Order', level: 'A', keywords: ['focus-order'] },
  { sc: '2.4.4', name: 'Link Purpose (In Context)', level: 'A', keywords: ['link-name'] },
  { sc: '2.4.5', name: 'Multiple Ways', level: 'AA', keywords: [] },
  { sc: '2.4.6', name: 'Headings and Labels', level: 'AA', keywords: ['empty-heading', 'label'] },
  { sc: '2.4.7', name: 'Focus Visible', level: 'AA', keywords: ['focus-visible'] },
  { sc: '2.4.11', name: 'Focus Not Obscured (Minimum)', level: 'AA', keywords: [] },
  { sc: '2.5.1', name: 'Pointer Gestures', level: 'A', keywords: [] },
  { sc: '2.5.2', name: 'Pointer Cancellation', level: 'A', keywords: [] },
  { sc: '2.5.3', name: 'Label in Name', level: 'A', keywords: ['label-in-name'] },
  { sc: '2.5.4', name: 'Motion Actuation', level: 'A', keywords: [] },
  { sc: '2.5.7', name: 'Dragging Movements', level: 'AA', keywords: [] },
  { sc: '2.5.8', name: 'Target Size (Minimum)', level: 'AA', keywords: ['target-size'] },
  // Understandable
  { sc: '3.1.1', name: 'Language of Page', level: 'A', keywords: ['html-has-lang', 'html-lang-valid'] },
  { sc: '3.1.2', name: 'Language of Parts', level: 'AA', keywords: ['valid-lang'] },
  { sc: '3.2.1', name: 'On Focus', level: 'A', keywords: [] },
  { sc: '3.2.2', name: 'On Input', level: 'A', keywords: [] },
  { sc: '3.2.3', name: 'Consistent Navigation', level: 'AA', keywords: [] },
  { sc: '3.2.4', name: 'Consistent Identification', level: 'AA', keywords: [] },
  { sc: '3.2.6', name: 'Consistent Help', level: 'A', keywords: [] },
  { sc: '3.3.1', name: 'Error Identification', level: 'A', keywords: ['aria-errormessage'] },
  { sc: '3.3.2', name: 'Labels or Instructions', level: 'A', keywords: ['label', 'form-field-multiple-labels'] },
  { sc: '3.3.3', name: 'Error Suggestion', level: 'AA', keywords: [] },
  { sc: '3.3.4', name: 'Error Prevention (Legal, Financial, Data)', level: 'AA', keywords: [] },
  { sc: '3.3.7', name: 'Redundant Entry', level: 'A', keywords: [] },
  { sc: '3.3.8', name: 'Accessible Authentication (Minimum)', level: 'AA', keywords: [] },
  // Robust
  { sc: '4.1.1', name: 'Parsing (Obsolete and removed in 2.2)', level: 'A', keywords: [] },
  { sc: '4.1.2', name: 'Name, Role, Value', level: 'A', keywords: ['aria-', 'button-name', 'input-button-name', 'role-img-alt', 'link-name'] },
  { sc: '4.1.3', name: 'Status Messages', level: 'AA', keywords: ['aria-live', 'role-status'] },
];

export type Conformance =
  | 'Supports'
  | 'Partially Supports'
  | 'Does Not Support'
  | 'Not Applicable'
  | 'Not Evaluated';

export interface VpatIssueInput {
  /** Axe rule id or uxinspect audit type. */
  type: string;
  message: string;
  impact?: 'minor' | 'moderate' | 'serious' | 'critical';
  nodes?: number;
}

export interface VpatRow {
  sc: string;
  name: string;
  level: 'A' | 'AA';
  conformance: Conformance;
  remarks: string;
  issueCount: number;
}

export function buildVpatRows(issues: VpatIssueInput[]): VpatRow[] {
  return SC_MAPPINGS.map((sc) => {
    const related = issues.filter((i) => matchesSc(i, sc));
    let conformance: Conformance;
    let remarks: string;
    if (sc.keywords.length === 0) {
      conformance = 'Not Evaluated';
      remarks = 'Requires human review.';
    } else if (related.length === 0) {
      conformance = 'Supports';
      remarks = 'No automated findings.';
    } else {
      const critical = related.filter((i) => i.impact === 'critical' || i.impact === 'serious');
      if (critical.length > 0 && critical.length === related.length) {
        conformance = 'Does Not Support';
      } else {
        conformance = 'Partially Supports';
      }
      remarks = summarize(related);
    }
    return {
      sc: sc.sc,
      name: sc.name,
      level: sc.level,
      conformance,
      remarks,
      issueCount: related.length,
    };
  });
}

function matchesSc(issue: VpatIssueInput, sc: ScMapping): boolean {
  const hay = `${issue.type} ${issue.message}`.toLowerCase();
  return sc.keywords.some((kw) => hay.includes(kw.toLowerCase()));
}

function summarize(issues: VpatIssueInput[]): string {
  const top = issues.slice(0, 3).map((i) => {
    const count = i.nodes ? ` (${i.nodes} element${i.nodes === 1 ? '' : 's'})` : '';
    return `${i.type}: ${i.message}${count}`;
  }).join('; ');
  const more = issues.length > 3 ? `; +${issues.length - 3} more findings` : '';
  return top + more;
}

export function generateVpatHtml(issues: VpatIssueInput[], opts: VpatOptions): string {
  const rows = buildVpatRows(issues);
  const perceivable = rows.filter((r) => r.sc.startsWith('1.'));
  const operable = rows.filter((r) => r.sc.startsWith('2.'));
  const understandable = rows.filter((r) => r.sc.startsWith('3.'));
  const robust = rows.filter((r) => r.sc.startsWith('4.'));

  const section = (title: string, group: VpatRow[]): string => `
<h2>${esc(title)}</h2>
<table>
  <thead><tr><th>Criteria</th><th>Level</th><th>Conformance</th><th>Remarks and Explanations</th></tr></thead>
  <tbody>${group.map(renderRow).join('')}</tbody>
</table>`;

  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>VPAT 2.5 INT — ${esc(opts.productName)} v${esc(opts.productVersion)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Inter, -apple-system, "Segoe UI", sans-serif; max-width: 960px; margin: 0 auto; padding: 32px; color: #1D1D1F; background: #FFFFFF; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 28px 0 10px; color: #1D1D1F; border-bottom: 1px solid #E5E7EB; padding-bottom: 4px; }
  p.meta { color: #4B5563; font-size: 13px; margin: 2px 0; }
  table { width: 100%; border-collapse: collapse; margin: 4px 0 16px; font-size: 12px; }
  th, td { border: 1px solid #E5E7EB; padding: 8px; text-align: left; vertical-align: top; }
  th { background: #ECFDF5; font-weight: 600; color: #1D1D1F; }
  .sc-id { white-space: nowrap; font-family: ui-monospace, monospace; }
  .conformance-Supports { color: #065F46; font-weight: 600; }
  .conformance-Partially { color: #92400E; font-weight: 600; }
  .conformance-Does { color: #991B1B; font-weight: 600; }
  .conformance-Not { color: #4B5563; }
  .logo { max-height: 40px; margin-bottom: 12px; }
  footer { margin-top: 40px; color: #6B7280; font-size: 11px; border-top: 1px solid #E5E7EB; padding-top: 12px; }
</style>
</head>
<body>
${opts.logo ? `<img class="logo" src="${esc(opts.logo)}" alt="">` : ''}
<h1>Voluntary Product Accessibility Template (VPAT&reg;) 2.5 INT</h1>
<p class="meta"><strong>Product:</strong> ${esc(opts.productName)} v${esc(opts.productVersion)}</p>
<p class="meta"><strong>Report Date:</strong> ${esc(date)}</p>
<p class="meta"><strong>Company:</strong> ${esc(opts.companyName ?? '')}</p>
${opts.companyAddress ? `<p class="meta"><strong>Address:</strong> ${esc(opts.companyAddress)}</p>` : ''}
<p class="meta"><strong>Contact:</strong> ${esc(opts.contactEmail)}</p>
<p class="meta"><strong>Evaluation Methods Used:</strong> ${esc(opts.evaluationMethods ?? 'Automated audit via uxinspect (axe-core); manual review required before publication.')}</p>

<h2>Conformance Summary</h2>
<table>
  <thead><tr><th>Standard</th><th>Level</th><th>Conformance</th></tr></thead>
  <tbody>
    <tr><td>WCAG 2.2</td><td>A</td><td>${overallConformance(rows, 'A')}</td></tr>
    <tr><td>WCAG 2.2</td><td>AA</td><td>${overallConformance(rows, 'AA')}</td></tr>
  </tbody>
</table>

${section('1. Perceivable', perceivable)}
${section('2. Operable', operable)}
${section('3. Understandable', understandable)}
${section('4. Robust', robust)}

<footer>
  Generated by uxinspect. VPAT&reg; is a registered trademark of the
  Information Technology Industry Council (ITI). This document is a
  self-assessment produced from automated tooling and must be reviewed
  and countersigned by a qualified accessibility specialist before
  distribution.
</footer>
</body></html>`;
}

function renderRow(r: VpatRow): string {
  const cls = r.conformance === 'Supports'
    ? 'conformance-Supports'
    : r.conformance === 'Partially Supports'
      ? 'conformance-Partially'
      : r.conformance === 'Does Not Support'
        ? 'conformance-Does'
        : 'conformance-Not';
  return `<tr><td><span class="sc-id">${esc(r.sc)}</span> — ${esc(r.name)}</td><td>${esc(r.level)}</td><td class="${cls}">${esc(r.conformance)}</td><td>${esc(r.remarks)}</td></tr>`;
}

function overallConformance(rows: VpatRow[], level: 'A' | 'AA'): string {
  const subset = rows.filter((r) => r.level === level);
  const any = subset.filter((r) => r.conformance === 'Does Not Support').length;
  const partial = subset.filter((r) => r.conformance === 'Partially Supports').length;
  if (any > 0) return 'Does Not Support';
  if (partial > 0) return 'Partially Supports';
  return 'Supports';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render the VPAT HTML and save a PDF via Playwright's `page.pdf()`.
 * Returns the saved absolute path.
 *
 * Playwright is imported dynamically so test runs that don't need the
 * PDF (the HTML tests) don't spin up a browser.
 */
export async function generateVpatPdf(
  issues: VpatIssueInput[],
  opts: VpatOptions,
  outPath: string,
): Promise<string> {
  const html = generateVpatHtml(issues, opts);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
    await page.pdf({
      path: path.resolve(outPath),
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' },
    });
    await context.close();
  } finally {
    await browser.close();
  }
  return path.resolve(outPath);
}

/**
 * Convenience for the CLI: take axe-style violations + VPAT metadata,
 * write the PDF, return the output path.
 */
export async function writeVpat(
  violations: VpatIssueInput[],
  opts: VpatOptions,
  outPath: string,
): Promise<string> {
  return generateVpatPdf(violations, opts, outPath);
}
