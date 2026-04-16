import type { ReactNode } from 'react';

type Tone = 'green' | 'red' | 'blue' | 'amber' | 'muted';

export function Badge({ tone = 'muted', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function StatusBadge({ status }: { status: 'passed' | 'failed' | 'running' | string }) {
  if (status === 'passed') return <Badge tone="green">Pass</Badge>;
  if (status === 'failed') return <Badge tone="red">Fail</Badge>;
  if (status === 'running') return <Badge tone="blue">Running</Badge>;
  return <Badge tone="muted">{status}</Badge>;
}
