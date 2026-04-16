export const packName = 'sveltekit';
export const flows = [
  { name: 'smoke-test', steps: [{ goto: '{{url}}' }] },
  { name: 'navigation', steps: [{ goto: '{{url}}' }, { click: 'nav a' }] },
  { name: 'error-boundary', steps: [{ goto: '{{url}}/404' }] },
];
