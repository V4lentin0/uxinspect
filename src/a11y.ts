import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from 'playwright';
import type { A11yResult } from './types.js';

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
