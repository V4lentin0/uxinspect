import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from 'playwright';
import type { A11yResult } from './types.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function checkA11y(page: Page): Promise<A11yResult> {
  const result = await new AxeBuilder({ page }).analyze();
  return {
    page: page.url(),
    violations: result.violations.map((v) => ({
      id: v.id,
      impact: (v.impact ?? 'minor') as A11yResult['violations'][0]['impact'],
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      nodes: v.nodes.map((n) => ({ html: n.html, target: n.target as string[] })),
    })),
    passed: result.violations.length === 0,
  };
}

export async function annotateA11y(
  page: Page,
  result: A11yResult,
  outPath: string,
): Promise<string | null> {
  if (result.violations.length === 0) return null;
  const targets = result.violations.flatMap((v) =>
    v.nodes.flatMap((n) => n.target.map((sel) => ({ sel, impact: v.impact, rule: v.id }))),
  );
  await page.evaluate(({ items }) => {
    const colors: Record<string, string> = {
      critical: '#EF4444',
      serious: '#F97316',
      moderate: '#F59E0B',
      minor: '#3B82F6',
    };
    for (const t of items) {
      try {
        const el = document.querySelector(t.sel) as HTMLElement | null;
        if (!el) continue;
        const overlay = document.createElement('div');
        const rect = el.getBoundingClientRect();
        overlay.style.position = 'absolute';
        overlay.style.left = rect.left + window.scrollX + 'px';
        overlay.style.top = rect.top + window.scrollY + 'px';
        overlay.style.width = rect.width + 'px';
        overlay.style.height = rect.height + 'px';
        overlay.style.border = '2px solid ' + (colors[t.impact] ?? '#3B82F6');
        overlay.style.background = (colors[t.impact] ?? '#3B82F6') + '22';
        overlay.style.pointerEvents = 'none';
        overlay.style.zIndex = '999999';
        overlay.setAttribute('data-uxinspect-a11y', t.rule);
        document.body.appendChild(overlay);
      } catch {}
    }
  }, { items: targets });
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await page.screenshot({ path: outPath, fullPage: true });
  await page.evaluate(() => {
    document.querySelectorAll('[data-uxinspect-a11y]').forEach((n) => n.remove());
  });
  return outPath;
}
