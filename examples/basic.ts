import { inspect } from '../src/index.js';

const result = await inspect({
  url: 'https://example.com',
  viewports: [
    { name: 'desktop', width: 1280, height: 800 },
    { name: 'mobile', width: 375, height: 667 },
  ],
  flows: [
    {
      name: 'home',
      steps: [{ goto: 'https://example.com' }, { waitFor: 'h1' }],
    },
  ],
  checks: { a11y: true, visual: true, explore: true },
  output: { dir: './report', baselineDir: './baselines' },
});

console.log(`Passed: ${result.passed}`);
console.log(`Flows: ${result.flows.length}, A11y issues: ${result.a11y?.flatMap((a) => a.violations).length ?? 0}`);
