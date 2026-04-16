import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildVpatRows, generateVpatHtml } from './wcag-vpat.js';

describe('wcag-vpat', () => {
  test('clean issue list marks all keyword-mapped SCs as Supports', () => {
    const rows = buildVpatRows([]);
    const mapped = rows.filter((r) => r.conformance !== 'Not Evaluated');
    assert.ok(mapped.length > 0);
    for (const row of mapped) {
      assert.equal(row.conformance, 'Supports', `${row.sc} should default to Supports`);
      assert.equal(row.issueCount, 0);
    }
  });

  test('image-alt axe finding lands on 1.1.1 as Does Not Support when critical', () => {
    const rows = buildVpatRows([
      { type: 'image-alt', message: 'Images must have alternate text', impact: 'critical', nodes: 3 },
    ]);
    const row = rows.find((r) => r.sc === '1.1.1');
    assert.ok(row);
    assert.equal(row!.conformance, 'Does Not Support');
    assert.equal(row!.issueCount, 1);
    assert.match(row!.remarks, /image-alt/);
  });

  test('color-contrast axe finding maps to 1.4.3', () => {
    const rows = buildVpatRows([
      { type: 'color-contrast', message: 'Elements must meet minimum color contrast ratio thresholds', impact: 'serious', nodes: 7 },
    ]);
    const row = rows.find((r) => r.sc === '1.4.3');
    assert.ok(row);
    assert.equal(row!.conformance, 'Does Not Support');
  });

  test('moderate-only finding flags as Partially Supports', () => {
    const rows = buildVpatRows([
      { type: 'label', message: 'Form elements must have labels', impact: 'moderate', nodes: 1 },
    ]);
    const row = rows.find((r) => r.sc === '3.3.2');
    assert.ok(row);
    assert.equal(row!.conformance, 'Partially Supports');
  });

  test('manual-review SCs without keywords are Not Evaluated', () => {
    const rows = buildVpatRows([]);
    const manual = rows.find((r) => r.sc === '1.3.3'); // Sensory Characteristics
    assert.ok(manual);
    assert.equal(manual!.conformance, 'Not Evaluated');
  });

  test('VPAT HTML includes product metadata and section headers', () => {
    const html = generateVpatHtml([], {
      productName: 'ExampleApp',
      productVersion: '1.2.3',
      contactEmail: 'a11y@example.test',
      companyName: 'Example Inc',
      date: '2025-01-01',
    });
    assert.match(html, /VPAT/);
    assert.match(html, /ExampleApp/);
    assert.match(html, /1\.2\.3/);
    assert.match(html, /Perceivable/);
    assert.match(html, /Operable/);
    assert.match(html, /Understandable/);
    assert.match(html, /Robust/);
    assert.match(html, /a11y@example\.test/);
    assert.match(html, /2025-01-01/);
  });

  test('HTML escapes angle brackets in remarks to prevent injection', () => {
    const html = generateVpatHtml(
      [{ type: 'image-alt', message: '<script>alert(1)</script>', impact: 'critical' }],
      { productName: 'X', productVersion: '1', contactEmail: 'x@example.test' },
    );
    assert.ok(!html.includes('<script>alert(1)'));
    assert.match(html, /&lt;script&gt;/);
  });

  test('conformance summary reports Does Not Support when any Level A row fails', () => {
    const html = generateVpatHtml(
      [{ type: 'image-alt', message: 'alt missing', impact: 'critical' }],
      { productName: 'X', productVersion: '1', contactEmail: 'x@example.test' },
    );
    // First summary row is Level A — should be Does Not Support.
    const tableMatch = html.match(/Conformance Summary[\s\S]*?<\/table>/);
    assert.ok(tableMatch);
    assert.match(tableMatch![0], /Does Not Support/);
  });
});
