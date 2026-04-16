export const packName = 'shopify';
export const flows = [
  { name: 'add-to-cart', steps: [{ goto: '{{url}}/products/{{product}}' }, { click: 'button[name=add]' }] },
  { name: 'checkout-flow', steps: [{ goto: '{{url}}/cart' }, { click: 'button[name=checkout]' }] },
  { name: 'theme-section-render', steps: [{ goto: '{{url}}' }, { waitfor: '.shopify-section' }] },
];
