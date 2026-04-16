/**
 * Minimal structural types mirroring the fields this extension reads from
 * `.uxinspect/last.json`. We deliberately keep these narrow — adding a field
 * in the core library must not force an extension release.
 *
 * Source of truth: `src/types.ts` in the main uxinspect repo.
 */

export interface StoredStep {
  // The serialized Step object. Actions are single-key objects such as
  // `{ click: '.login' }` or `{ goto: 'https://...' }`.
  [key: string]: unknown;
}

export interface StoredStepResult {
  step: StoredStep;
  passed: boolean;
  durationMs?: number;
  error?: string;
  assertions?: { kind: string; message: string }[];
}

export interface StoredFlowResult {
  name: string;
  passed: boolean;
  steps: StoredStepResult[];
  error?: string;
  /** Optional pre-resolved absolute/relative file path if uxinspect ever emits it. */
  filePath?: string;
  /** Optional line number (1-based) if uxinspect ever emits it. */
  line?: number;
}

export interface StoredInspectResult {
  url?: string;
  startedAt?: string;
  passed?: boolean;
  flows?: StoredFlowResult[];
}
