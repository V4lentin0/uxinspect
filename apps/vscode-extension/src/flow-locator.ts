/**
 * Locate `name: '<flow>'` declarations inside ts/js source files.
 *
 * Uses a deliberately dumb regex scanner so we don't pull in a full TS parser.
 * The shape we care about is:
 *
 *   { name: 'signup', steps: [...] }
 *   { name: "signup", steps: [...] }
 *   { name: `signup`, steps: [...] }
 *
 * We anchor on `name:` followed by a string literal, then verify `steps`
 * appears within the next ~500 characters so we don't match arbitrary
 * objects with a `name` property.
 */

export interface FlowLocation {
  name: string;
  line: number; // 0-indexed
  column: number; // 0-indexed, start of the name string
  nameLength: number;
}

const FLOW_NAME_RE = /name\s*:\s*(['"`])([^'"`\n\r]+)\1/g;
const STEPS_LOOKAHEAD = 500;

export function findFlowLocations(source: string): FlowLocation[] {
  const out: FlowLocation[] = [];
  let match: RegExpExecArray | null;
  // Reset lastIndex for safety when the regex instance is shared.
  FLOW_NAME_RE.lastIndex = 0;
  while ((match = FLOW_NAME_RE.exec(source)) !== null) {
    const nameStart = match.index + match[0].indexOf(match[1]) + 1; // inside quote
    const name = match[2];
    const afterMatch = source.slice(match.index, match.index + STEPS_LOOKAHEAD);
    // Heuristic: must be followed by `steps:` reasonably close by.
    if (!/\bsteps\s*:/.test(afterMatch)) {
      continue;
    }
    const { line, column } = offsetToLineCol(source, nameStart);
    out.push({ name, line, column, nameLength: name.length });
  }
  return out;
}

export function findFlowByName(source: string, name: string): FlowLocation | undefined {
  return findFlowLocations(source).find((f) => f.name === name);
}

export function offsetToLineCol(source: string, offset: number): { line: number; column: number } {
  let line = 0;
  let lineStart = 0;
  const end = Math.min(offset, source.length);
  for (let i = 0; i < end; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart };
}
