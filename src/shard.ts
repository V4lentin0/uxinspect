import type { InspectConfig, Flow } from './types.js';

export interface ShardSpec {
  index: number;
  total: number;
}

const SHARD_ERROR = 'invalid shard: expected K/N with 1 <= K <= N';

function djb2(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    // hash * 33 + c, kept as unsigned 32-bit for stability
    hash = (((hash << 5) + hash) + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function assignShard(name: string, total: number): number {
  return (djb2(name) % total) + 1;
}

export function parseShardArg(arg: string): ShardSpec {
  if (typeof arg !== 'string') throw new Error(SHARD_ERROR);
  const match = /^(\d+)\/(\d+)$/.exec(arg.trim());
  if (!match) throw new Error(SHARD_ERROR);
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isInteger(index) || !Number.isInteger(total)) throw new Error(SHARD_ERROR);
  if (index < 1 || total < 1 || index > total) throw new Error(SHARD_ERROR);
  return { index, total };
}

function validateSpec(spec: ShardSpec): void {
  if (!spec || typeof spec !== 'object') throw new Error(SHARD_ERROR);
  const { index, total } = spec;
  if (!Number.isInteger(index) || !Number.isInteger(total)) throw new Error(SHARD_ERROR);
  if (index < 1 || total < 1 || index > total) throw new Error(SHARD_ERROR);
}

export function shardFlows(flows: Flow[], spec: ShardSpec): Flow[] {
  validateSpec(spec);
  if (!Array.isArray(flows) || flows.length === 0) return [];
  const out: Flow[] = [];
  for (const flow of flows) {
    if (assignShard(flow.name, spec.total) === spec.index) out.push(flow);
  }
  return out;
}

export function shardConfig(cfg: InspectConfig, spec: ShardSpec): InspectConfig {
  validateSpec(spec);
  const flows = cfg.flows;
  if (!flows || flows.length === 0) return cfg;
  return { ...cfg, flows: shardFlows(flows, spec) };
}

export function shardSummary(
  flows: Flow[],
  total: number,
): { index: number; count: number; names: string[] }[] {
  if (!Number.isInteger(total) || total < 1) throw new Error(SHARD_ERROR);
  const buckets: { index: number; count: number; names: string[] }[] = [];
  for (let i = 1; i <= total; i++) buckets.push({ index: i, count: 0, names: [] });
  if (!Array.isArray(flows)) return buckets;
  for (const flow of flows) {
    const idx = assignShard(flow.name, total);
    const bucket = buckets[idx - 1];
    if (!bucket) continue;
    bucket.count += 1;
    bucket.names.push(flow.name);
  }
  return buckets;
}
