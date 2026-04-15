import test from 'node:test';
import assert from 'node:assert/strict';
import {
  eventsToSteps,
  stepsToConfigTs,
  stepsToFlowSnippet,
  coalesceInputs,
  bestSelector,
} from '../lib/converter.js';

// -- eventsToSteps --------------------------------------------------------

test('click event → { click: selector }', () => {
  const steps = eventsToSteps([
    { type: 'click', selector: '[data-testid="save"]', at: 1 },
  ]);
  assert.deepEqual(steps, [{ click: '[data-testid="save"]' }]);
});

test('input event → { fill: { selector, text } }', () => {
  const steps = eventsToSteps([
    { type: 'input', selector: '#email', text: 'a@b.co', at: 1 },
  ]);
  assert.deepEqual(steps, [{ fill: { selector: '#email', text: 'a@b.co' } }]);
});

test('navigate event → { goto: url }', () => {
  const steps = eventsToSteps([
    { type: 'navigate', url: 'https://example.com/login', at: 1 },
  ]);
  assert.deepEqual(steps, [{ goto: 'https://example.com/login' }]);
});

test('consecutive input keystrokes coalesce into one fill', () => {
  const steps = eventsToSteps([
    { type: 'input', selector: '#email', text: 'a', at: 1 },
    { type: 'input', selector: '#email', text: 'ab', at: 2 },
    { type: 'input', selector: '#email', text: 'abc', at: 3 },
  ]);
  assert.deepEqual(steps, [{ fill: { selector: '#email', text: 'abc' } }]);
});

test('input to different selector does not coalesce', () => {
  const steps = eventsToSteps([
    { type: 'input', selector: '#email', text: 'a@b', at: 1 },
    { type: 'input', selector: '#pass', text: 'secret', at: 2 },
  ]);
  assert.deepEqual(steps, [
    { fill: { selector: '#email', text: 'a@b' } },
    { fill: { selector: '#pass', text: 'secret' } },
  ]);
});

test('click between inputs breaks coalescing', () => {
  const steps = eventsToSteps([
    { type: 'input', selector: '#q', text: 'foo', at: 1 },
    { type: 'click', selector: 'button.go', at: 2 },
    { type: 'input', selector: '#q', text: 'bar', at: 3 },
  ]);
  assert.deepEqual(steps, [
    { fill: { selector: '#q', text: 'foo' } },
    { click: 'button.go' },
    { fill: { selector: '#q', text: 'bar' } },
  ]);
});

test('duplicate consecutive navigations are deduped', () => {
  const steps = eventsToSteps([
    { type: 'navigate', url: 'https://ex.com/', at: 1 },
    { type: 'navigate', url: 'https://ex.com/', at: 2 },
    { type: 'click', selector: 'a', at: 3 },
    { type: 'navigate', url: 'https://ex.com/page', at: 4 },
  ]);
  assert.deepEqual(steps, [
    { goto: 'https://ex.com/' },
    { click: 'a' },
    { goto: 'https://ex.com/page' },
  ]);
});

test('full recording: goto → fill → click produces runnable sequence', () => {
  const steps = eventsToSteps([
    { type: 'navigate', url: 'https://app.example.com/login', at: 1 },
    { type: 'input', selector: '#email', text: 'user@example.com', at: 2 },
    { type: 'input', selector: '#password', text: 's3cret', at: 3 },
    { type: 'click', selector: 'role=button[name="Sign in"]', at: 4 },
  ]);
  assert.deepEqual(steps, [
    { goto: 'https://app.example.com/login' },
    { fill: { selector: '#email', text: 'user@example.com' } },
    { fill: { selector: '#password', text: 's3cret' } },
    { click: 'role=button[name="Sign in"]' },
  ]);
});

test('skips unknown event types', () => {
  const steps = eventsToSteps([
    { type: 'mystery', at: 1 },
    { type: 'click', selector: 'a', at: 2 },
  ]);
  assert.deepEqual(steps, [{ click: 'a' }]);
});

test('skips events missing required fields', () => {
  const steps = eventsToSteps([
    { type: 'click', at: 1 }, // no selector
    { type: 'input', selector: '#x', at: 2 }, // no text is ok (empty)
    { type: 'navigate', at: 3 }, // no url
  ]);
  assert.deepEqual(steps, [{ fill: { selector: '#x', text: '' } }]);
});

// -- coalesceInputs (direct) ---------------------------------------------

test('coalesceInputs preserves event order and non-input events', () => {
  const out = coalesceInputs([
    { type: 'input', selector: '#a', text: 'x', at: 1 },
    { type: 'input', selector: '#a', text: 'xy', at: 2 },
    { type: 'click', selector: 'btn', at: 3 },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].text, 'xy');
  assert.equal(out[1].type, 'click');
});

// -- render helpers ------------------------------------------------------

test('stepsToConfigTs outputs valid uxinspect config shape', () => {
  const ts = stepsToConfigTs(
    [
      { goto: 'https://ex.com' },
      { click: 'button' },
    ],
    'my-flow',
  );
  assert.match(ts, /import \{ defineConfig \} from 'uxinspect';/);
  assert.match(ts, /export default defineConfig\(\{/);
  assert.match(ts, /url: 'https:\/\/ex\.com'/);
  assert.match(ts, /name: 'my-flow'/);
  assert.match(ts, /"click":"button"/);
});

test('stepsToConfigTs falls back to placeholder url when no goto', () => {
  const ts = stepsToConfigTs([{ click: 'button' }], 'recorded');
  assert.match(ts, /url: 'https:\/\/example\.com'/);
});

test('stepsToFlowSnippet renders a plain flow object', () => {
  const out = stepsToFlowSnippet([{ click: 'a' }], 'r');
  assert.match(out, /name: 'r'/);
  assert.match(out, /"click":"a"/);
  assert.ok(!out.includes('defineConfig'));
});

// -- bestSelector (JSDOM-free: build minimal DOM-shaped mocks) -----------

function makeEl(overrides = {}) {
  const attrs = overrides.attrs || {};
  const el = {
    nodeType: 1,
    tagName: (overrides.tagName || 'DIV').toUpperCase(),
    parentNode: null,
    children: [],
    ownerDocument: null,
    innerText: overrides.innerText || '',
    textContent: overrides.textContent || overrides.innerText || '',
    className: overrides.className || '',
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
  };
  return el;
}

test('bestSelector prefers data-testid', () => {
  const el = makeEl({ tagName: 'button', attrs: { 'data-testid': 'save-btn' }, innerText: 'Save' });
  assert.equal(bestSelector(el), '[data-testid="save-btn"]');
});

test('bestSelector uses role + name when no testid', () => {
  const el = makeEl({ tagName: 'button', innerText: 'Submit', attrs: {} });
  assert.equal(bestSelector(el), 'role=button[name="Submit"]');
});

test('bestSelector falls back to text for generic elements', () => {
  const el = makeEl({ tagName: 'span', innerText: 'Click me', attrs: {} });
  assert.equal(bestSelector(el), 'text="Click me"');
});

test('bestSelector uses #id when id is clean and no better option', () => {
  const el = makeEl({ tagName: 'div', attrs: { id: 'main' } });
  assert.equal(bestSelector(el), '#main');
});
