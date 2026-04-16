export const packName = 'nuxt';
export const flows = [
  { name: 'smoke-test', steps: [{ goto: '{{url}}' }] },
  { name: 'navigation', steps: [{ goto: '{{url}}' }, { click: 'nav a' }] },
  { name: 'error-boundary', steps: [{ goto: '{{url}}/404' }] },
];
