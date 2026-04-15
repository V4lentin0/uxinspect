// uxinspect Recorder — event → Step[] converter
// Vanilla JS (runs in extension + Node tests). No deps.
//
// Captured event shape (from content.js):
//   { type: 'click', selector: '<best>', at: <ts> }
//   { type: 'input', selector: '<best>', text: '<final value>', at: <ts> }
//   { type: 'navigate', url: '<href>', at: <ts> }
//
// Output: uxinspect Step[]
//   click    -> { click: '<selector>' }
//   input    -> { fill: { selector, text } }
//   navigate -> { goto: url }

/**
 * Build a best-effort selector for an element using Playwright-style priority:
 *   1. data-testid / data-test / data-test-id
 *   2. role + accessible name (getByRole pattern)
 *   3. text content (short, unique)
 *   4. CSS (id -> tag+attrs -> nth-child fallback)
 *
 * Returns a string selector usable by Playwright locators:
 *   - [data-testid="foo"]
 *   - role=button[name="Save"]
 *   - text="Sign in"
 *   - #main
 *   - button.submit
 */
export function bestSelector(el) {
  if (!el || el.nodeType !== 1) return '';

  // 1. testid attributes
  const testAttrs = ['data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa'];
  for (const attr of testAttrs) {
    const v = el.getAttribute && el.getAttribute(attr);
    if (v) return `[${attr}="${cssEscape(v)}"]`;
  }

  // 2. role + name
  const role = ariaRole(el);
  const name = accessibleName(el);
  if (role && name && name.length <= 50) {
    return `role=${role}[name="${escapeQuotes(name)}"]`;
  }

  // 3. visible text (short, no punctuation noise)
  const text = (el.innerText || el.textContent || '').trim();
  if (text && text.length > 0 && text.length <= 40 && !text.includes('\n')) {
    return `text="${escapeQuotes(text)}"`;
  }

  // 4. CSS
  return cssSelector(el);
}

function cssEscape(s) {
  return String(s).replace(/(["\\])/g, '\\$1');
}

function escapeQuotes(s) {
  return String(s).replace(/"/g, '\\"');
}

function ariaRole(el) {
  const explicit = el.getAttribute && el.getAttribute('role');
  if (explicit) return explicit;
  const tag = (el.tagName || '').toLowerCase();
  const type = (el.getAttribute && el.getAttribute('type') || '').toLowerCase();
  const map = {
    a: 'link',
    button: 'button',
    nav: 'navigation',
    header: 'banner',
    footer: 'contentinfo',
    main: 'main',
    aside: 'complementary',
    form: 'form',
    section: 'region',
    h1: 'heading', h2: 'heading', h3: 'heading',
    h4: 'heading', h5: 'heading', h6: 'heading',
    img: 'img',
    select: 'combobox',
    textarea: 'textbox',
  };
  if (tag === 'input') {
    if (['button', 'submit', 'reset'].includes(type)) return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
    if (['text', 'email', 'password', 'search', 'tel', 'url', 'number', ''].includes(type)) return 'textbox';
  }
  return map[tag] || null;
}

function accessibleName(el) {
  if (!el.getAttribute) return '';
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby && el.ownerDocument) {
    const parts = labelledby.split(/\s+/)
      .map(id => el.ownerDocument.getElementById(id))
      .filter(Boolean)
      .map(n => (n.innerText || n.textContent || '').trim());
    const joined = parts.join(' ').trim();
    if (joined) return joined;
  }
  const label = el.getAttribute('aria-label');
  if (label) return label.trim();
  const title = el.getAttribute('title');
  if (title) return title.trim();
  const alt = el.getAttribute('alt');
  if (alt) return alt.trim();
  const placeholder = el.getAttribute('placeholder');
  if (placeholder) return placeholder.trim();
  // For form elements: associated <label for="id">
  const id = el.getAttribute('id');
  if (id && el.ownerDocument) {
    const lab = el.ownerDocument.querySelector(`label[for="${cssEscape(id)}"]`);
    if (lab) return (lab.innerText || lab.textContent || '').trim();
  }
  // Fallback: innerText for buttons/links
  const tag = (el.tagName || '').toLowerCase();
  if (['button', 'a'].includes(tag)) {
    return (el.innerText || el.textContent || '').trim();
  }
  return '';
}

function cssSelector(el) {
  if (!el || !el.tagName) return '';
  const id = el.getAttribute && el.getAttribute('id');
  if (id && !/\s/.test(id) && !/^\d/.test(id)) {
    return `#${cssEscape(id)}`;
  }
  const tag = el.tagName.toLowerCase();
  // Try tag + classes (first 2 stable-looking)
  const cls = (el.className || '').toString()
    .split(/\s+/)
    .filter(c => c && !/^(is-|has-|ng-|css-|sc-|_)/.test(c) && !/^\d/.test(c))
    .slice(0, 2);
  if (cls.length > 0) return `${tag}.${cls.join('.')}`;
  // Name attr for inputs
  const name = el.getAttribute && el.getAttribute('name');
  if (name) return `${tag}[name="${cssEscape(name)}"]`;
  // Type attr for inputs
  const type = el.getAttribute && el.getAttribute('type');
  if (type && tag === 'input') return `input[type="${cssEscape(type)}"]`;
  // nth-of-type fallback with parent chain (up to 3 levels)
  return nthPath(el);
}

function nthPath(el) {
  const parts = [];
  let cur = el;
  let depth = 0;
  while (cur && cur.nodeType === 1 && depth < 4) {
    let sel = cur.tagName.toLowerCase();
    const parent = cur.parentNode;
    if (parent && parent.children) {
      const sibs = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
      if (sibs.length > 1) {
        const idx = sibs.indexOf(cur) + 1;
        sel += `:nth-of-type(${idx})`;
      }
    }
    parts.unshift(sel);
    if (parent && parent.tagName && parent.tagName.toLowerCase() !== 'html') {
      cur = parent;
      depth++;
    } else break;
  }
  return parts.join(' > ');
}

/**
 * Coalesce consecutive input events on the same selector into one fill step.
 * Events are already sorted by timestamp from the recorder.
 */
export function coalesceInputs(events) {
  const out = [];
  for (const ev of events) {
    if (ev.type !== 'input') {
      out.push(ev);
      continue;
    }
    const prev = out[out.length - 1];
    if (prev && prev.type === 'input' && prev.selector === ev.selector) {
      prev.text = ev.text;
      prev.at = ev.at;
    } else {
      out.push({ ...ev });
    }
  }
  return out;
}

/**
 * Convert raw event stream -> uxinspect Step[]
 */
export function eventsToSteps(events) {
  const normalized = coalesceInputs(events);
  const steps = [];
  for (const ev of normalized) {
    if (ev.type === 'click' && ev.selector) {
      steps.push({ click: ev.selector });
    } else if (ev.type === 'input' && ev.selector) {
      steps.push({ fill: { selector: ev.selector, text: ev.text || '' } });
    } else if (ev.type === 'navigate' && ev.url) {
      // Dedupe consecutive navigates to same URL
      const prev = steps[steps.length - 1];
      if (!prev || !('goto' in prev) || prev.goto !== ev.url) {
        steps.push({ goto: ev.url });
      }
    }
  }
  return steps;
}

/**
 * Render Step[] as a runnable uxinspect config .ts file.
 */
export function stepsToConfigTs(steps, flowName = 'recorded') {
  const firstGoto = steps.find(s => 'goto' in s);
  const url = firstGoto ? firstGoto.goto : 'https://example.com';
  const body = steps.map(s => '      ' + JSON.stringify(s)).join(',\n');
  return `import { defineConfig } from 'uxinspect';

export default defineConfig({
  url: '${url}',
  flows: [
    {
      name: '${flowName}',
      steps: [
${body}
      ]
    }
  ]
});
`;
}

/**
 * Render Step[] as a standalone snippet (just the flow object) for clipboard paste.
 */
export function stepsToFlowSnippet(steps, flowName = 'recorded') {
  const body = steps.map(s => '    ' + JSON.stringify(s)).join(',\n');
  return `{
  name: '${flowName}',
  steps: [
${body}
  ]
}`;
}
