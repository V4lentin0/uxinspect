import type { AnomalyRing } from '../api';

/**
 * Renders the P2 #20 anomaly-ring format: one SVG donut per metric,
 * coloured by severity band (ok=green, info=blue, warn=amber, fail=red).
 * The ring "fills" proportional to the delta between baseline and current,
 * capped at 100% for readability. Fully accessible — each ring has an
 * aria-label summarising the numbers.
 */
export function AnomalyRings({ rings }: { rings: AnomalyRing[] }) {
  if (!rings.length) return null;
  return (
    <div className="rings" role="list">
      {rings.map((r) => (
        <Ring key={r.metric} ring={r} />
      ))}
    </div>
  );
}

const TONE: Record<AnomalyRing['severity'], string> = {
  ok: '#10B981',
  info: '#3B82F6',
  warn: '#F59E0B',
  fail: '#EF4444',
};

function Ring({ ring }: { ring: AnomalyRing }) {
  const size = 64;
  const stroke = 8;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const denom = Math.max(Math.abs(ring.baseline), 1);
  const pct = Math.min(Math.abs(ring.delta) / denom, 1);
  const dash = pct * circ;
  const color = TONE[ring.severity];
  return (
    <div
      className="ring"
      role="listitem"
      aria-label={`${ring.label}: baseline ${ring.baseline}, current ${ring.current}, ${
        ring.delta >= 0 ? 'up' : 'down'
      } ${Math.abs(ring.delta)}, severity ${ring.severity}`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="#E5E7EB"
          strokeWidth={stroke}
          fill="none"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${dash} ${circ - dash}`}
          strokeDashoffset={circ / 4}
          strokeLinecap="round"
        />
        <text
          x="50%"
          y="52%"
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize="11"
          fontWeight="600"
          fill="#1D1D1F"
        >
          {ring.current}
        </text>
      </svg>
      <div className="ring-label">
        {ring.label}
        <br />
        <span className="text-muted">
          {ring.delta >= 0 ? '+' : ''}
          {ring.delta} vs base
        </span>
      </div>
    </div>
  );
}
