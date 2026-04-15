import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { findFlowByName, findFlowLocations, offsetToLineCol } from '../src/flow-locator';

const SAMPLE = `import { inspect } from 'uxinspect';

const result = await inspect({
  url: 'https://example.com',
  flows: [
    {
      name: 'home',
      steps: [
        { goto: 'https://example.com' },
        { waitFor: 'h1' },
      ],
    },
    {
      name: "signup",
      steps: [
        { goto: '/signup' },
        { click: '#submit' },
      ],
    },
    {
      name: \`checkout\`,
      steps: [{ click: '.buy' }],
    },
    // This one has no steps sibling — should be ignored.
    { name: 'bare-name' },
  ],
});
`;

test('findFlowLocations finds all three flow names', () => {
  const locs = findFlowLocations(SAMPLE);
  const names = locs.map((l) => l.name);
  assert.deepEqual(names, ['home', 'signup', 'checkout']);
});

test('findFlowLocations ignores bare name objects without steps', () => {
  const locs = findFlowLocations(SAMPLE);
  assert.ok(!locs.find((l) => l.name === 'bare-name'), 'bare-name must be filtered out');
});

test('findFlowByName returns correct line for signup', () => {
  const loc = findFlowByName(SAMPLE, 'signup');
  assert.ok(loc, 'signup flow location must exist');
  // Lines are 0-indexed. The word `signup` lives on SAMPLE line index 12.
  const lines = SAMPLE.split('\n');
  const idx = lines.findIndex((l) => l.includes(`name: "signup"`));
  assert.equal(loc!.line, idx);
});

test('findFlowByName returns correct line for home', () => {
  const loc = findFlowByName(SAMPLE, 'home');
  assert.ok(loc);
  const lines = SAMPLE.split('\n');
  const idx = lines.findIndex((l) => l.includes(`name: 'home'`));
  assert.equal(loc!.line, idx);
});

test('findFlowByName returns correct line for template literal name', () => {
  const loc = findFlowByName(SAMPLE, 'checkout');
  assert.ok(loc);
  const lines = SAMPLE.split('\n');
  const idx = lines.findIndex((l) => l.includes('`checkout`'));
  assert.equal(loc!.line, idx);
});

test('findFlowByName column points inside opening quote', () => {
  const loc = findFlowByName(SAMPLE, 'home');
  assert.ok(loc);
  const lines = SAMPLE.split('\n');
  const line = lines[loc!.line];
  // The slice starting at `column` should equal the flow name.
  const slice = line.slice(loc!.column, loc!.column + loc!.nameLength);
  assert.equal(slice, 'home');
});

test('offsetToLineCol handles offset at start of file', () => {
  const { line, column } = offsetToLineCol('abc\ndef', 0);
  assert.equal(line, 0);
  assert.equal(column, 0);
});

test('offsetToLineCol handles offset after newline', () => {
  const { line, column } = offsetToLineCol('abc\ndef', 4);
  assert.equal(line, 1);
  assert.equal(column, 0);
});

test('offsetToLineCol handles offset in the middle of the second line', () => {
  const { line, column } = offsetToLineCol('abc\ndef\nghi', 9);
  assert.equal(line, 2);
  assert.equal(column, 1);
});

test('findFlowLocations returns empty for source without flows', () => {
  const src = `const x = { name: 'nope' };\nfunction foo() { return 42; }`;
  assert.deepEqual(findFlowLocations(src), []);
});

test('findFlowLocations handles duplicate flow names', () => {
  const src = `
    { name: 'dup', steps: [] },
    { name: 'dup', steps: [] },
  `;
  const locs = findFlowLocations(src);
  assert.equal(locs.length, 2);
  assert.equal(locs[0].name, 'dup');
  assert.equal(locs[1].name, 'dup');
  assert.notEqual(locs[0].line, locs[1].line);
});
