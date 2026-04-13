export interface InspectConfig {
  url: string;
  flows?: Flow[];
  viewports?: Viewport[];
  checks?: ChecksConfig;
  output?: OutputConfig;
  ai?: AIConfig;
}

export interface Flow {
  name: string;
  steps: Step[];
}

export type Step =
  | { goto: string }
  | { click: string }
  | { type: { selector: string; text: string } }
  | { fill: { selector: string; text: string } }
  | { waitFor: string }
  | { screenshot: string }
  | { ai: string };

export interface Viewport {
  name: string;
  width: number;
  height: number;
}

export interface ChecksConfig {
  a11y?: boolean;
  perf?: boolean;
  visual?: boolean;
  explore?: boolean | { maxClicks?: number };
}

export interface OutputConfig {
  dir?: string;
  baselineDir?: string;
  reportFormat?: 'html' | 'json' | 'both';
}

export interface AIConfig {
  enabled?: boolean;
  apiKey?: string;
  model?: string;
}

export interface InspectResult {
  url: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  flows: FlowResult[];
  a11y?: A11yResult[];
  perf?: PerfResult[];
  visual?: VisualResult[];
  explore?: ExploreResult;
  passed: boolean;
}

export interface FlowResult {
  name: string;
  passed: boolean;
  steps: StepResult[];
  screenshots: string[];
  error?: string;
}

export interface StepResult {
  step: Step;
  passed: boolean;
  durationMs: number;
  error?: string;
}

export interface A11yResult {
  page: string;
  violations: A11yViolation[];
  passed: boolean;
}

export interface A11yViolation {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical';
  description: string;
  help: string;
  helpUrl: string;
  nodes: { html: string; target: string[] }[];
}

export interface PerfResult {
  page: string;
  scores: {
    performance: number;
    accessibility: number;
    bestPractices: number;
    seo: number;
  };
  metrics: {
    lcp: number;
    fcp: number;
    cls: number;
    tbt: number;
    si: number;
  };
}

export interface VisualResult {
  page: string;
  viewport: string;
  baseline: string;
  current: string;
  diff?: string;
  diffPixels: number;
  diffRatio: number;
  passed: boolean;
}

export interface ExploreResult {
  pagesVisited: number;
  buttonsClicked: number;
  formsSubmitted: number;
  errors: string[];
  consoleErrors: string[];
  networkErrors: string[];
}
