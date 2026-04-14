export type TriageCategory =
  | 'timeout'
  | 'selector-stale'
  | 'network'
  | 'flaky'
  | 'infra'
  | 'assertion'
  | 'security'
  | 'permission'
  | 'unknown';

export interface TriageRule {
  category: TriageCategory;
  pattern: RegExp;
  weight: number;
}

export interface TriageInput {
  error: string;
  step?: string;
  historyOutcomes?: Array<'pass' | 'fail'>;
  consoleErrors?: string[];
  networkErrors?: string[];
}

export interface TriageResult {
  category: TriageCategory;
  confidence: number;
  reasons: string[];
  suggestions: string[];
}

export const TRIAGE_RULES: TriageRule[] = [
  // timeout
  { category: 'timeout', pattern: /TimeoutError/i, weight: 9 },
  { category: 'timeout', pattern: /exceeded.*ms timeout/i, weight: 9 },
  { category: 'timeout', pattern: /waiting for .* to be (visible|stable|enabled|attached|hidden)/i, weight: 8 },
  { category: 'timeout', pattern: /locator\.click.*timeout/i, weight: 8 },
  { category: 'timeout', pattern: /navigation timeout/i, weight: 9 },
  { category: 'timeout', pattern: /timed? out after \d+/i, weight: 8 },
  { category: 'timeout', pattern: /deadline exceeded/i, weight: 7 },
  // selector-stale
  { category: 'selector-stale', pattern: /no element matches selector/i, weight: 9 },
  { category: 'selector-stale', pattern: /element is not attached/i, weight: 9 },
  { category: 'selector-stale', pattern: /stale element/i, weight: 9 },
  { category: 'selector-stale', pattern: /strict mode violation/i, weight: 8 },
  { category: 'selector-stale', pattern: /element\(s\) not found/i, weight: 9 },
  { category: 'selector-stale', pattern: /page\.\$eval.*returned null/i, weight: 8 },
  { category: 'selector-stale', pattern: /could not find element/i, weight: 8 },
  { category: 'selector-stale', pattern: /resolved to \d+ elements/i, weight: 7 },
  // network
  { category: 'network', pattern: /net::ERR_/i, weight: 9 },
  { category: 'network', pattern: /fetch failed/i, weight: 8 },
  { category: 'network', pattern: /socket hang up/i, weight: 8 },
  { category: 'network', pattern: /ECONNRESET/, weight: 9 },
  { category: 'network', pattern: /ENOTFOUND/, weight: 9 },
  { category: 'network', pattern: /getaddrinfo/i, weight: 8 },
  { category: 'network', pattern: /\b5\d\d\b/, weight: 6 },
  { category: 'network', pattern: /TLS/i, weight: 7 },
  { category: 'network', pattern: /certificate/i, weight: 7 },
  { category: 'network', pattern: /ECONNREFUSED/, weight: 9 },
  { category: 'network', pattern: /EAI_AGAIN/, weight: 8 },
  // security
  { category: 'security', pattern: /Content Security Policy/i, weight: 9 },
  { category: 'security', pattern: /CORS/, weight: 9 },
  { category: 'security', pattern: /Refused to (connect|load|execute)/i, weight: 8 },
  { category: 'security', pattern: /blocked by client/i, weight: 7 },
  { category: 'security', pattern: /SameSite/i, weight: 7 },
  { category: 'security', pattern: /mixed content/i, weight: 7 },
  // permission
  { category: 'permission', pattern: /permission denied/i, weight: 8 },
  { category: 'permission', pattern: /NotAllowedError/, weight: 9 },
  { category: 'permission', pattern: /requires user activation/i, weight: 8 },
  { category: 'permission', pattern: /geolocation/i, weight: 7 },
  { category: 'permission', pattern: /clipboard.*denied/i, weight: 8 },
  { category: 'permission', pattern: /(camera|microphone).*denied/i, weight: 8 },
  // infra
  { category: 'infra', pattern: /browser has been closed/i, weight: 9 },
  { category: 'infra', pattern: /Target page, context or browser has been closed/i, weight: 9 },
  { category: 'infra', pattern: /page crashed/i, weight: 10 },
  { category: 'infra', pattern: /OOM|out of memory/i, weight: 10 },
  { category: 'infra', pattern: /SIGKILL|SIGTERM/, weight: 9 },
  { category: 'infra', pattern: /worker crashed/i, weight: 9 },
  { category: 'infra', pattern: /Target closed/i, weight: 7 },
  // assertion
  { category: 'assertion', pattern: /expected .* received/i, weight: 9 },
  { category: 'assertion', pattern: /AssertionError/, weight: 10 },
  { category: 'assertion', pattern: /expect\(/i, weight: 7 },
  { category: 'assertion', pattern: /to (equal|match|contain|be)\b/i, weight: 6 },
  { category: 'assertion', pattern: /deepEqual/i, weight: 8 },
  { category: 'assertion', pattern: /did not pass/i, weight: 7 },
  { category: 'assertion', pattern: /toBe(Truthy|Falsy|Defined|Null|Undefined)/i, weight: 7 },
];

const SUGGESTIONS: Record<TriageCategory, string[]> = {
  timeout: [
    'Increase step timeout for this action.',
    'Check if the target is behind an animation or lazy-load gate.',
    'Wait for a specific stable condition instead of a fixed sleep.',
  ],
  'selector-stale': [
    'Use auto-retry locators instead of one-shot queries.',
    'Prefer role or accessible-name based locators over brittle CSS selectors.',
    'Add a wait for the element to be attached and stable before interacting.',
  ],
  network: [
    'Retry with exponential backoff and a small jitter.',
    'Verify the API base URL and environment configuration.',
    'Check TLS chain, DNS resolution, and outbound firewall rules.',
  ],
  flaky: [
    'Quarantine the test in a flaky suite until stabilised.',
    'Replace timing-based waits with deterministic conditions.',
    'Mock time, randomness, and network responses to remove non-determinism.',
  ],
  infra: [
    'Check CI runner resource limits, especially memory and disk.',
    'Re-run the job on a fresh worker to rule out a poisoned environment.',
    'Reduce parallelism or shard the suite if workers are saturated.',
  ],
  assertion: [
    'Verify the expectation against current product behaviour.',
    'Check for timezone, locale, or rounding drift between environments.',
    'Snapshot the actual value and update the assertion if behaviour intentionally changed.',
  ],
  security: [
    'Review response headers for CSP, CORS, and cookie policy directives.',
    'Allowlist required origins or relax restrictive directives in the test environment.',
  ],
  permission: [
    'Grant the required browser permission in the test context before navigation.',
    'Trigger the action through a real user gesture rather than a programmatic call.',
  ],
  unknown: [
    'Capture full stack trace, console output, and network log for deeper analysis.',
  ],
};

function applyRules(
  text: string,
  scale: number,
  scores: Map<TriageCategory, number>,
  reasons: string[],
  source: string,
): void {
  if (!text) return;
  for (const rule of TRIAGE_RULES) {
    if (rule.pattern.test(text)) {
      const add = rule.weight * scale;
      scores.set(rule.category, (scores.get(rule.category) ?? 0) + add);
      reasons.push(`${source} matched pattern for ${rule.category}: ${rule.pattern.source}`);
    }
  }
}

function detectFlaky(
  outcomes: Array<'pass' | 'fail'> | undefined,
): { flaky: boolean; weight: number; reason?: string } {
  if (!outcomes || outcomes.length < 3) return { flaky: false, weight: 0 };
  const passes = outcomes.filter((o) => o === 'pass').length;
  const fails = outcomes.length - passes;
  if (passes === 0 || fails === 0) return { flaky: false, weight: 0 };
  const ratio = Math.min(passes, fails) / outcomes.length;
  const weight = 10 + ratio * 10;
  return {
    flaky: true,
    weight,
    reason: `history shows ${passes} pass / ${fails} fail across last ${outcomes.length} runs`,
  };
}

export function triageFailure(input: TriageInput): TriageResult {
  const scores = new Map<TriageCategory, number>();
  const reasons: string[] = [];

  applyRules(input.error ?? '', 1, scores, reasons, 'error');
  for (const ce of input.consoleErrors ?? []) {
    applyRules(ce, 0.5, scores, reasons, 'console');
  }
  for (const ne of input.networkErrors ?? []) {
    applyRules(ne, 0.5, scores, reasons, 'network log');
    scores.set('network', (scores.get('network') ?? 0) + 1);
  }

  const step = (input.step ?? '').toLowerCase();
  const errLower = (input.error ?? '').toLowerCase();
  if (step.includes('click') && /timeout|waiting for/i.test(errLower)) {
    const boost = 4;
    scores.set('selector-stale', (scores.get('selector-stale') ?? 0) + boost);
    reasons.push('step contains "click" with a wait/timeout error: leaning selector-stale');
  }
  if ((step.includes('navigate') || step.includes('goto')) && /timeout/i.test(errLower)) {
    scores.set('network', (scores.get('network') ?? 0) + 2);
    reasons.push('navigation step with timeout: nudging network');
  }

  const flaky = detectFlaky(input.historyOutcomes);
  if (flaky.flaky) {
    scores.set('flaky', (scores.get('flaky') ?? 0) + flaky.weight);
    if (flaky.reason) reasons.push(flaky.reason);
  }

  let winner: TriageCategory = 'unknown';
  let winnerWeight = 0;
  let total = 0;
  for (const [cat, w] of scores) {
    total += w;
    if (w > winnerWeight) {
      winnerWeight = w;
      winner = cat;
    }
  }

  let confidence = total > 0 ? winnerWeight / total : 0;
  if (winner === 'unknown' || total === 0) {
    confidence = 0.2;
  } else {
    confidence = Math.max(0.2, Math.min(1, confidence));
  }

  if (winner === 'unknown' && reasons.length === 0) {
    reasons.push('no known patterns matched the failure signal');
  }

  return {
    category: winner,
    confidence,
    reasons,
    suggestions: SUGGESTIONS[winner],
  };
}

export function triageBatch(
  inputs: TriageInput[],
): { counts: Record<TriageCategory, number>; results: TriageResult[] } {
  const counts: Record<TriageCategory, number> = {
    timeout: 0,
    'selector-stale': 0,
    network: 0,
    flaky: 0,
    infra: 0,
    assertion: 0,
    security: 0,
    permission: 0,
    unknown: 0,
  };
  const results: TriageResult[] = [];
  for (const input of inputs) {
    const r = triageFailure(input);
    counts[r.category] += 1;
    results.push(r);
  }
  results.sort((a, b) => b.confidence - a.confidence);
  return { counts, results };
}
