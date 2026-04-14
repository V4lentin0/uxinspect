import type { Step, Flow } from './types.js';

export type GherkinKeyword = 'Given' | 'When' | 'Then' | 'And' | 'But';

export interface GherkinStep {
  keyword: GherkinKeyword;
  text: string;
  dataTable?: string[][];
  docString?: string;
}

export interface GherkinScenario {
  name: string;
  tags: string[];
  steps: GherkinStep[];
  examples?: Record<string, string>[];
}

export interface GherkinFeature {
  name: string;
  description?: string;
  tags: string[];
  background?: { steps: GherkinStep[] };
  scenarios: GherkinScenario[];
}

export interface StepDefinition {
  pattern: RegExp | string;
  execute: (match: RegExpMatchArray, step: GherkinStep) => Step[];
}

const STEP_KEYWORDS: GherkinKeyword[] = ['Given', 'When', 'Then', 'And', 'But'];

interface RawLine {
  raw: string;
  text: string;
  indent: number;
  lineNo: number;
}

function tokenize(text: string): RawLine[] {
  const out: RawLine[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    out.push({ raw, text: trimmed, indent, lineNo: i + 1 });
  }
  return out;
}

function parseTableRow(line: string): string[] {
  const body = line.trim();
  if (!body.startsWith('|') || !body.endsWith('|')) return [];
  const inner = body.slice(1, -1);
  const cells: string[] = [];
  let buf = '';
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === '\\' && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next === '|') {
        buf += '|';
        i += 2;
        continue;
      }
      if (next === 'n') {
        buf += '\n';
        i += 2;
        continue;
      }
      if (next === '\\') {
        buf += '\\';
        i += 2;
        continue;
      }
    }
    if (ch === '|') {
      cells.push(buf.trim());
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  cells.push(buf.trim());
  return cells;
}

function parseTags(line: string): string[] {
  return line
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.startsWith('@'));
}

function startsWithStepKeyword(text: string): GherkinKeyword | null {
  for (const kw of STEP_KEYWORDS) {
    if (text === kw || text.startsWith(kw + ' ') || text.startsWith(kw + '\t')) {
      return kw;
    }
  }
  return null;
}

export function parseFeature(text: string): GherkinFeature {
  const tokens = tokenize(text);

  const feature: GherkinFeature = {
    name: '',
    tags: [],
    scenarios: [],
  };

  let pendingTags: string[] = [];
  let descriptionLines: string[] = [];
  let current: GherkinScenario | null = null;
  let inBackground = false;
  let lastStep: GherkinStep | null = null;
  let examplesHeader: string[] | null = null;
  let examplesTarget: GherkinScenario | null = null;
  let featureStarted = false;

  const flushDescription = () => {
    if (!featureStarted) return;
    if (descriptionLines.length && !current) {
      feature.description = descriptionLines.join('\n').trim();
    }
  };

  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx];
    const line = tok.text;

    // Doc string block
    if (line === '"""' || line === '```') {
      const fence = line;
      const baseIndent = tok.indent;
      const docLines: string[] = [];
      idx++;
      while (idx < tokens.length) {
        const inner = tokens[idx];
        if (inner.text === fence && inner.indent <= baseIndent + 2) {
          break;
        }
        // Preserve relative indentation inside doc string
        const stripped = inner.raw.slice(Math.min(baseIndent, inner.raw.length - inner.raw.trimStart().length));
        docLines.push(stripped);
        idx++;
      }
      if (lastStep) {
        lastStep.docString = docLines.join('\n');
      }
      continue;
    }

    // Tags line
    if (line.startsWith('@')) {
      pendingTags.push(...parseTags(line));
      continue;
    }

    // Data table row
    if (line.startsWith('|')) {
      const row = parseTableRow(line);
      if (examplesHeader === null && examplesTarget) {
        examplesHeader = row;
        examplesTarget.examples = examplesTarget.examples ?? [];
        continue;
      }
      if (examplesHeader && examplesTarget) {
        const entry: Record<string, string> = {};
        for (let c = 0; c < examplesHeader.length; c++) {
          entry[examplesHeader[c]] = row[c] ?? '';
        }
        examplesTarget.examples!.push(entry);
        continue;
      }
      if (lastStep) {
        lastStep.dataTable = lastStep.dataTable ?? [];
        lastStep.dataTable.push(row);
        continue;
      }
      continue;
    }

    // Feature
    if (line.startsWith('Feature:')) {
      feature.name = line.slice('Feature:'.length).trim();
      feature.tags = pendingTags.slice();
      pendingTags = [];
      featureStarted = true;
      descriptionLines = [];
      current = null;
      inBackground = false;
      lastStep = null;
      examplesHeader = null;
      examplesTarget = null;
      continue;
    }

    // Background
    if (line.startsWith('Background:')) {
      feature.background = { steps: [] };
      current = null;
      inBackground = true;
      lastStep = null;
      examplesHeader = null;
      examplesTarget = null;
      flushDescription();
      descriptionLines = [];
      continue;
    }

    // Scenario / Scenario Outline
    if (line.startsWith('Scenario Outline:') || line.startsWith('Scenario Template:')) {
      flushDescription();
      descriptionLines = [];
      const name = line.replace(/^Scenario (Outline|Template):/, '').trim();
      current = { name, tags: [...feature.tags, ...pendingTags], steps: [] };
      pendingTags = [];
      feature.scenarios.push(current);
      inBackground = false;
      lastStep = null;
      examplesHeader = null;
      examplesTarget = null;
      continue;
    }
    if (line.startsWith('Scenario:') || line.startsWith('Example:')) {
      flushDescription();
      descriptionLines = [];
      const name = line.replace(/^(Scenario|Example):/, '').trim();
      current = { name, tags: [...feature.tags, ...pendingTags], steps: [] };
      pendingTags = [];
      feature.scenarios.push(current);
      inBackground = false;
      lastStep = null;
      examplesHeader = null;
      examplesTarget = null;
      continue;
    }

    // Examples
    if (line.startsWith('Examples:') || line.startsWith('Scenarios:')) {
      if (current) {
        examplesTarget = current;
        examplesHeader = null;
      }
      lastStep = null;
      continue;
    }

    // Step
    const kw = startsWithStepKeyword(line);
    if (kw) {
      const stepText = line.slice(kw.length).trim();
      const step: GherkinStep = { keyword: kw, text: stepText };
      if (inBackground && feature.background) {
        feature.background.steps.push(step);
      } else if (current) {
        current.steps.push(step);
      }
      lastStep = step;
      continue;
    }

    // Free-form description / rule text (ignored except for feature description)
    if (featureStarted && !current && !inBackground) {
      descriptionLines.push(line);
    }
  }

  flushDescription();
  return feature;
}

function substitutePlaceholders(text: string, row: Record<string, string>): string {
  return text.replace(/<([^<>]+)>/g, (full, key) => {
    if (key in row) return row[key];
    return full;
  });
}

function applyRowToStep(step: GherkinStep, row: Record<string, string>): GherkinStep {
  const next: GherkinStep = {
    keyword: step.keyword,
    text: substitutePlaceholders(step.text, row),
  };
  if (step.dataTable) {
    next.dataTable = step.dataTable.map((r) => r.map((c) => substitutePlaceholders(c, row)));
  }
  if (step.docString !== undefined) {
    next.docString = substitutePlaceholders(step.docString, row);
  }
  return next;
}

function matchStep(step: GherkinStep, defs: StepDefinition[]): Step[] {
  for (const def of defs) {
    const pattern = typeof def.pattern === 'string' ? new RegExp('^' + escapeStringRegex(def.pattern) + '$') : def.pattern;
    const match = step.text.match(pattern);
    if (match) {
      return def.execute(match, step);
    }
  }
  throw new Error(`No step definition matched: "${step.keyword} ${step.text}"`);
}

function escapeStringRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function featureToFlows(feature: GherkinFeature, stepDefs: StepDefinition[]): Flow[] {
  const flows: Flow[] = [];
  const backgroundSteps = feature.background?.steps ?? [];

  for (const scenario of feature.scenarios) {
    const rows: Record<string, string>[] = scenario.examples && scenario.examples.length > 0
      ? scenario.examples
      : [{}];

    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const row = rows[rIdx];
      const suffix = scenario.examples && scenario.examples.length > 0 ? ` [${rIdx + 1}]` : '';
      const steps: Step[] = [];

      for (const bg of backgroundSteps) {
        const applied = Object.keys(row).length > 0 ? applyRowToStep(bg, row) : bg;
        steps.push(...matchStep(applied, stepDefs));
      }

      for (const s of scenario.steps) {
        const applied = Object.keys(row).length > 0 ? applyRowToStep(s, row) : s;
        steps.push(...matchStep(applied, stepDefs));
      }

      flows.push({ name: scenario.name + suffix, steps });
    }
  }

  return flows;
}

export const builtinSteps: StepDefinition[] = [
  {
    pattern: /^I visit "(.+)"$/,
    execute: (match) => [{ goto: match[1] }],
  },
  {
    pattern: /^I click "(.+)"$/,
    execute: (match) => [{ click: `text=${match[1]}` }],
  },
  {
    pattern: /^I type "(.+)" into "(.+)"$/,
    execute: (match) => [{ fill: { selector: match[2], text: match[1] } }],
  },
  {
    pattern: /^I should see "(.+)"$/,
    execute: (match) => [{ waitFor: `text=${match[1]}` }],
  },
  {
    pattern: /^I wait (\d+) seconds?$/,
    execute: (match) => [{ sleep: parseInt(match[1], 10) * 1000 }],
  },
  {
    pattern: /^I press "(.+)"$/,
    execute: (match) => [{ key: match[1] }],
  },
  {
    pattern: /^I reload the page$/,
    execute: () => [{ reload: true }],
  },
];
