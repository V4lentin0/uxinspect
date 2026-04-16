/**
 * P5 #51 — Status page HTML renderer.
 * Generates a static HTML page showing monitor status for a team.
 */

interface Monitor {
  name: string;
  url: string;
  status: 'up' | 'degraded' | 'down';
  uptimePercent: number;
  lastCheckedAt: string;
  dailyUptimes?: number[]; // 90 days, 0-100 each
}

interface Incident {
  monitorName: string;
  status: 'active' | 'resolved';
  startedAt: string;
  resolvedAt?: string;
  message: string;
}

interface StatusData {
  team: string;
  overallStatus: 'operational' | 'degraded' | 'major_outage';
  monitors: Monitor[];
  incidents: Incident[];
}

const STATUS_COLORS: Record<string, string> = {
  up: '#10B981',
  degraded: '#F59E0B',
  down: '#EF4444',
  operational: '#10B981',
  major_outage: '#EF4444',
};

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderStatusPage(data: StatusData): string {
  const overallColor = STATUS_COLORS[data.overallStatus] || STATUS_COLORS.operational;
  const overallLabel = data.overallStatus === 'operational' ? 'All Systems Operational'
    : data.overallStatus === 'degraded' ? 'Some Systems Degraded'
    : 'Major Outage';

  const monitorCards = data.monitors.map((m) => {
    const color = STATUS_COLORS[m.status] || '#E5E7EB';
    const bars = (m.dailyUptimes || []).slice(-90).map((pct) => {
      const c = pct >= 99 ? '#10B981' : pct >= 95 ? '#F59E0B' : '#EF4444';
      return `<div style="flex:1;height:32px;background:${c};border-radius:2px;min-width:2px" title="${pct}%"></div>`;
    }).join('');

    return `<div style="background:#fff;border:1px solid #E5E7EB;border-radius:8px;padding:16px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,0.04)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-weight:600">${esc(m.name)}</div>
        <span style="background:${color};color:#fff;padding:2px 10px;border-radius:12px;font-size:12px">${esc(m.status)}</span>
      </div>
      <div style="color:#6B7280;font-size:13px;margin-bottom:8px">${esc(m.url)} — ${m.uptimePercent.toFixed(2)}% uptime</div>
      ${bars ? `<div style="display:flex;gap:1px;height:32px">${bars}</div><div style="display:flex;justify-content:space-between;font-size:11px;color:#9CA3AF;margin-top:4px"><span>90 days ago</span><span>Today</span></div>` : ''}
    </div>`;
  }).join('');

  const incidentList = data.incidents.length === 0
    ? '<p style="color:#6B7280">No recent incidents.</p>'
    : data.incidents.map((i) => {
        const badge = i.status === 'active'
          ? '<span style="background:#EF4444;color:#fff;padding:1px 6px;border-radius:4px;font-size:11px">active</span>'
          : '<span style="background:#10B981;color:#fff;padding:1px 6px;border-radius:4px;font-size:11px">resolved</span>';
        return `<div style="padding:10px 0;border-bottom:1px solid #E5E7EB">
          <div style="display:flex;gap:8px;align-items:center">${badge} <strong>${esc(i.monitorName)}</strong></div>
          <div style="color:#6B7280;font-size:13px;margin-top:4px">${esc(i.message)}</div>
          <div style="color:#9CA3AF;font-size:12px;margin-top:2px">${esc(i.startedAt)}${i.resolvedAt ? ' — ' + esc(i.resolvedAt) : ''}</div>
        </div>`;
      }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(data.team)} Status</title>
<link rel="stylesheet" href="/style.css">
</head>
<body style="margin:0;font-family:Inter,-apple-system,system-ui,sans-serif;background:#FAFAFA;color:#1D1D1F">
<div style="max-width:720px;margin:0 auto;padding:24px 16px">
  <h1 style="font-size:24px;font-weight:700;margin:0 0 4px">${esc(data.team)} Status</h1>
  <div style="display:inline-block;padding:6px 16px;border-radius:8px;background:${overallColor};color:#fff;font-weight:600;margin:12px 0 24px">${overallLabel}</div>
  <h2 style="font-size:16px;font-weight:600;margin:0 0 12px">Monitors</h2>
  ${data.monitors.length === 0 ? '<p style="color:#6B7280">No monitors configured.</p>' : monitorCards}
  <h2 style="font-size:16px;font-weight:600;margin:24px 0 12px">Incidents</h2>
  ${incidentList}
  <footer style="margin-top:32px;padding-top:16px;border-top:1px solid #E5E7EB;color:#9CA3AF;font-size:12px;text-align:center">
    Powered by <a href="https://uxinspect.com" style="color:#10B981;text-decoration:none">uxinspect</a>
  </footer>
</div>
</body>
</html>`;
}

export function render404(team: string): string {
  return `<!DOCTYPE html><html><head><title>Not Found</title></head><body style="font-family:Inter,sans-serif;background:#FAFAFA;color:#1D1D1F;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1>404</h1><p>Status page for "${esc(team)}" not found.</p></div></body></html>`;
}

export function renderError(): string {
  return `<!DOCTYPE html><html><head><title>Error</title></head><body style="font-family:Inter,sans-serif;background:#FAFAFA;color:#1D1D1F;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1>Error</h1><p>Failed to load status data. Try again later.</p></div></body></html>`;
}
