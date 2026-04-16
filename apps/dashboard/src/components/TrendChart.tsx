import type { TrendPoint } from '../api';

interface Props {
  points: TrendPoint[];
  metric: 'durationMs' | 'a11y' | 'visualFails' | 'perf';
  height?: number;
  label: string;
}

const SERIES_COLOR: Record<Props['metric'], string> = {
  durationMs: '#3B82F6',
  a11y: '#10B981',
  visualFails: '#F59E0B',
  perf: '#10B981',
};

function valueOf(p: TrendPoint, m: Props['metric']): number | null {
  if (m === 'durationMs') return p.durationMs;
  if (m === 'a11y') return p.a11y;
  if (m === 'visualFails') return p.visualFails;
  if (m === 'perf') return p.perf;
  return null;
}

/**
 * Lightweight SVG line chart — no external chart lib. Normalises values
 * into a 0..1 band so every metric renders cleanly without config.
 * Dots are tinted pass/fail based on the run's pass flag.
 */
export function TrendChart({ points, metric, height = 180, label }: Props) {
  if (!points.length) {
    return (
      <div className="chart" role="img" aria-label={`${label} trend (no data)`}>
        <div className="loading">No runs in this window yet.</div>
      </div>
    );
  }
  const w = 800;
  const h = height;
  const pad = 24;
  const xs = points.map((_, i) => pad + (i * (w - 2 * pad)) / Math.max(points.length - 1, 1));
  const vals = points.map((p) => valueOf(p, metric));
  const finite = vals.filter((v): v is number => typeof v === 'number');
  const max = finite.length ? Math.max(...finite) : 1;
  const min = finite.length ? Math.min(...finite) : 0;
  const span = max - min || 1;
  const ys = vals.map((v) =>
    v === null ? null : h - pad - ((v - min) / span) * (h - 2 * pad),
  );
  const path = ys
    .map((y, i) =>
      y === null ? null : `${i === 0 ? 'M' : 'L'}${xs[i].toFixed(1)} ${y.toFixed(1)}`,
    )
    .filter(Boolean)
    .join(' ');
  const last = vals[vals.length - 1];
  const first = vals[0];
  const delta = typeof last === 'number' && typeof first === 'number' ? last - first : null;
  return (
    <div>
      <div
        className="flex-between"
        style={{ padding: '0 4px 8px', fontSize: 12, color: 'var(--text-muted)' }}
      >
        <span>
          {label}
          {delta !== null ? (
            <span
              className={delta >= 0 ? 'stat-trend-down' : 'stat-trend-up'}
              style={{ marginLeft: 8, fontWeight: 600 }}
            >
              {delta >= 0 ? '+' : ''}
              {delta}
            </span>
          ) : null}
        </span>
        <span>
          {points.length} runs
        </span>
      </div>
      <svg
        className="chart"
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label} trend across ${points.length} runs`}
      >
        <rect width={w} height={h} fill="#FFFFFF" rx={8} />
        <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="#E5E7EB" />
        <line x1={pad} y1={pad} x2={pad} y2={h - pad} stroke="#E5E7EB" />
        <path d={path} stroke={SERIES_COLOR[metric]} strokeWidth="2" fill="none" />
        {points.map((p, i) => {
          const y = ys[i];
          if (y === null) return null;
          return (
            <circle
              key={p.runId}
              cx={xs[i]}
              cy={y}
              r={3.5}
              fill={p.passed ? '#10B981' : '#EF4444'}
            />
          );
        })}
      </svg>
    </div>
  );
}
