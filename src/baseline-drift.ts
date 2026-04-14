import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface DriftRun {
  timestamp: string;
  diffPixels: number;
  diffRatio: number;
  ssim?: number;
  accepted: boolean;
}

export interface BaselineDriftRecord {
  baselineKey: string;
  baselinePath: string;
  runs: DriftRun[];
  autoApprovedAt?: string;
  autoApprovedCount: number;
}

export interface DriftDatabase {
  version: 1;
  records: Record<string, BaselineDriftRecord>;
}

export interface DriftDecision {
  action: 'accept' | 'reject' | 'quarantine';
  reason: string;
  autoApprove: boolean;
  confidence: number;
}

export interface DriftPolicy {
  maxHistory?: number;
  autoApproveThreshold?: number;
  pixelRatioBand?: number;
  ssimBand?: number;
  quarantineAfter?: number;
}

interface ResolvedPolicy {
  maxHistory: number;
  autoApproveThreshold: number;
  pixelRatioBand: number;
  ssimBand: number;
  quarantineAfter: number;
}

const DEFAULT_POLICY: ResolvedPolicy = {
  maxHistory: 20,
  autoApproveThreshold: 3,
  pixelRatioBand: 0.002,
  ssimBand: 0.01,
  quarantineAfter: 5,
};

function resolvePolicy(policy?: DriftPolicy): ResolvedPolicy {
  return {
    maxHistory: policy?.maxHistory ?? DEFAULT_POLICY.maxHistory,
    autoApproveThreshold: policy?.autoApproveThreshold ?? DEFAULT_POLICY.autoApproveThreshold,
    pixelRatioBand: policy?.pixelRatioBand ?? DEFAULT_POLICY.pixelRatioBand,
    ssimBand: policy?.ssimBand ?? DEFAULT_POLICY.ssimBand,
    quarantineAfter: policy?.quarantineAfter ?? DEFAULT_POLICY.quarantineAfter,
  };
}

function isDriftDb(value: unknown): value is DriftDatabase {
  if (!value || typeof value !== 'object') return false;
  const v = value as { version?: unknown; records?: unknown };
  if (v.version !== 1) return false;
  if (!v.records || typeof v.records !== 'object') return false;
  return true;
}

export async function loadDriftDb(filePath: string): Promise<DriftDatabase> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isDriftDb(parsed)) return { version: 1, records: {} };
    return parsed;
  } catch {
    return { version: 1, records: {} };
  }
}

export async function saveDriftDb(filePath: string, db: DriftDatabase): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(db, null, 2);
  await fs.writeFile(tmp, payload, 'utf8');
  try {
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) * (v - m);
  return Math.sqrt(acc / (values.length - 1));
}

function withinBand(run: DriftRun, p: ResolvedPolicy): boolean {
  if (run.diffRatio > p.pixelRatioBand) return false;
  if (typeof run.ssim === 'number' && 1 - run.ssim > p.ssimBand) return false;
  return true;
}

function recentRejections(record: BaselineDriftRecord, window: number): number {
  let count = 0;
  for (let i = 0; i < record.runs.length && i < window; i++) {
    if (!record.runs[i].accepted) count++;
  }
  return count;
}

export function shouldAutoApprove(
  record: BaselineDriftRecord,
  policy?: DriftPolicy,
): DriftDecision {
  const p = resolvePolicy(policy);
  const runs = record.runs;

  if (runs.length < p.autoApproveThreshold) {
    return {
      action: 'reject',
      reason: 'insufficient history',
      autoApprove: false,
      confidence: 0,
    };
  }

  const window = runs.slice(0, p.autoApproveThreshold);
  const allWithinBand = window.every((r) => withinBand(r, p));

  const ratios = window.map((r) => r.diffRatio);
  const sigma = stdev(ratios);

  if (sigma > p.pixelRatioBand) {
    return {
      action: 'quarantine',
      reason: 'oscillating drift exceeds band stdev',
      autoApprove: false,
      confidence: 0.4,
    };
  }

  const recentRej = recentRejections(record, p.quarantineAfter);
  if (recentRej >= p.quarantineAfter) {
    return {
      action: 'quarantine',
      reason: `>=${p.quarantineAfter} recent rejections`,
      autoApprove: false,
      confidence: 0.3,
    };
  }

  if (allWithinBand) {
    const tightness = 1 - sigma / Math.max(p.pixelRatioBand, 1e-9);
    const confidence = Math.max(0.6, Math.min(0.95, 0.7 + 0.25 * tightness));
    return {
      action: 'accept',
      reason: 'stable drift within band',
      autoApprove: true,
      confidence,
    };
  }

  return {
    action: 'reject',
    reason: 'recent run outside drift band',
    autoApprove: false,
    confidence: 0.2,
  };
}

function emptyRecord(baselineKey: string): BaselineDriftRecord {
  return {
    baselineKey,
    baselinePath: '',
    runs: [],
    autoApprovedCount: 0,
  };
}

export function recordRun(
  db: DriftDatabase,
  baselineKey: string,
  run: Omit<DriftRun, 'accepted'>,
  policy?: DriftPolicy,
): { db: DriftDatabase; decision: DriftDecision } {
  const p = resolvePolicy(policy);
  const existing = db.records[baselineKey] ?? emptyRecord(baselineKey);
  const previous = existing.runs[0];

  const candidate: DriftRun = {
    timestamp: run.timestamp,
    diffPixels: run.diffPixels,
    diffRatio: run.diffRatio,
    ssim: run.ssim,
    accepted: false,
  };

  const withinVsPrevious =
    !previous ||
    (Math.abs(candidate.diffRatio - previous.diffRatio) <= p.pixelRatioBand &&
      withinBand(candidate, p));

  const speculative: BaselineDriftRecord = {
    ...existing,
    runs: [candidate, ...existing.runs].slice(0, p.maxHistory),
  };

  let decision: DriftDecision;
  if (!withinVsPrevious) {
    decision = {
      action: 'reject',
      reason: 'jump from previous run exceeds band',
      autoApprove: false,
      confidence: 0.1,
    };
  } else {
    decision = shouldAutoApprove(speculative, p);
  }

  candidate.accepted = decision.action === 'accept';

  const updatedRuns = [candidate, ...existing.runs].slice(0, p.maxHistory);
  const updated: BaselineDriftRecord = {
    ...existing,
    runs: updatedRuns,
    autoApprovedCount:
      decision.action === 'accept' ? existing.autoApprovedCount + 1 : existing.autoApprovedCount,
    autoApprovedAt:
      decision.action === 'accept' ? candidate.timestamp : existing.autoApprovedAt,
  };

  if (
    updated.autoApprovedCount >= p.maxHistory &&
    recentRejections(updated, p.quarantineAfter) >= p.quarantineAfter
  ) {
    decision = {
      action: 'quarantine',
      reason: 'long-lived baseline destabilised',
      autoApprove: false,
      confidence: 0.2,
    };
  }

  const nextDb: DriftDatabase = {
    version: 1,
    records: { ...db.records, [baselineKey]: updated },
  };

  return { db: nextDb, decision };
}

export function detectRegression(
  record: BaselineDriftRecord,
  latest: DriftRun,
  policy?: DriftPolicy,
): { regression: boolean; zscore: number } {
  const p = resolvePolicy(policy);
  const prior = record.runs.filter((r) => r.timestamp !== latest.timestamp);
  if (prior.length < 4) return { regression: false, zscore: 0 };

  const ratios = prior.map((r) => r.diffRatio);
  const m = mean(ratios);
  const s = stdev(ratios);
  const zscore = (latest.diffRatio - m) / Math.max(s, 1e-6);
  const regression = zscore > 3 && latest.diffRatio > m + p.pixelRatioBand;
  return { regression, zscore };
}
