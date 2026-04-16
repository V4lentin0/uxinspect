export const packName = 'nextjs';
export const flows = [
  { name: 'hydration-check', steps: [{ goto: '{{url}}' }, { click: '[data-hydrated]' }] },
  { name: 'server-action', steps: [{ goto: '{{url}}/api' }, { click: 'form button[type=submit]' }] },
  { name: 'streaming-check', steps: [{ goto: '{{url}}' }, { waitfor: '[data-streaming-complete]' }] },
];
