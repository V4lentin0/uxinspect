import { readFile, writeFile } from 'node:fs/promises';

export interface HarWaterfallEntry {
  url: string;
  method: string;
  status: number;
  mimeType: string;
  sizeBytes: number;
  startTimeMs: number;
  durationMs: number;
  timings: {
    blocked?: number;
    dns?: number;
    connect?: number;
    ssl?: number;
    send?: number;
    wait?: number;
    receive?: number;
  };
}

export interface HarWaterfallSummary {
  totalRequests: number;
  totalBytes: number;
  firstRequestStart: number;
  lastRequestEnd: number;
  criticalPathMs: number;
}

export interface HarWaterfallReport {
  entries: HarWaterfallEntry[];
  summary: HarWaterfallSummary;
}

interface HarTimings {
  blocked?: number;
  dns?: number;
  connect?: number;
  ssl?: number;
  send?: number;
  wait?: number;
  receive?: number;
}

interface HarContent {
  size?: number;
  mimeType?: string;
}

interface HarResponse {
  status?: number;
  bodySize?: number;
  content?: HarContent;
}

interface HarRequest {
  method?: string;
  url?: string;
}

interface HarEntry {
  startedDateTime?: string;
  time?: number;
  request?: HarRequest;
  response?: HarResponse;
  timings?: HarTimings;
}

interface HarLog {
  entries?: HarEntry[];
}

interface HarFile {
  log?: HarLog;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return undefined;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function pickTiming(value: unknown): number | undefined {
  const n = asNumber(value);
  if (n === undefined) return undefined;
  return n < 0 ? undefined : n;
}

function parseHarFile(harContent: string): HarFile {
  const parsed: unknown = JSON.parse(harContent);
  if (!isRecord(parsed)) return {};
  const log = parsed['log'];
  if (!isRecord(log)) return {};
  const entriesRaw = log['entries'];
  if (!Array.isArray(entriesRaw)) return { log: {} };
  const entries: HarEntry[] = entriesRaw.filter(isRecord).map((raw) => {
    const request = isRecord(raw['request']) ? raw['request'] : {};
    const response = isRecord(raw['response']) ? raw['response'] : {};
    const timings = isRecord(raw['timings']) ? raw['timings'] : {};
    const content = isRecord(response['content']) ? response['content'] : {};
    return {
      startedDateTime: asString(raw['startedDateTime']),
      time: asNumber(raw['time']),
      request: {
        method: asString(request['method']),
        url: asString(request['url']),
      },
      response: {
        status: asNumber(response['status']),
        bodySize: asNumber(response['bodySize']),
        content: {
          size: asNumber(content['size']),
          mimeType: asString(content['mimeType']),
        },
      },
      timings: {
        blocked: pickTiming(timings['blocked']),
        dns: pickTiming(timings['dns']),
        connect: pickTiming(timings['connect']),
        ssl: pickTiming(timings['ssl']),
        send: pickTiming(timings['send']),
        wait: pickTiming(timings['wait']),
        receive: pickTiming(timings['receive']),
      },
    };
  });
  return { log: { entries } };
}

export function parseHar(harContent: string): HarWaterfallReport {
  const har = parseHarFile(harContent);
  const rawEntries = har.log?.entries ?? [];
  if (rawEntries.length === 0) {
    return {
      entries: [],
      summary: {
        totalRequests: 0,
        totalBytes: 0,
        firstRequestStart: 0,
        lastRequestEnd: 0,
        criticalPathMs: 0,
      },
    };
  }

  const epochs: number[] = rawEntries.map((e) => {
    const t = Date.parse(e.startedDateTime ?? '');
    return Number.isFinite(t) ? t : 0;
  });
  const earliest = Math.min(...epochs);

  const entries: HarWaterfallEntry[] = rawEntries.map((e, idx) => {
    const startTimeMs = Math.max(0, (epochs[idx] ?? earliest) - earliest);
    const durationMs = e.time ?? 0;
    const contentSize = e.response?.content?.size ?? 0;
    const bodySize = e.response?.bodySize ?? 0;
    const sizeBytes = contentSize > 0 ? contentSize : Math.max(0, bodySize);
    return {
      url: e.request?.url ?? '',
      method: (e.request?.method ?? 'GET').toUpperCase(),
      status: e.response?.status ?? 0,
      mimeType: e.response?.content?.mimeType ?? '',
      sizeBytes,
      startTimeMs,
      durationMs,
      timings: {
        blocked: e.timings?.blocked,
        dns: e.timings?.dns,
        connect: e.timings?.connect,
        ssl: e.timings?.ssl,
        send: e.timings?.send,
        wait: e.timings?.wait,
        receive: e.timings?.receive,
      },
    };
  });

  const totalBytes = entries.reduce((acc, e) => acc + e.sizeBytes, 0);
  const firstRequestStart = entries.reduce(
    (min, e) => Math.min(min, e.startTimeMs),
    Number.POSITIVE_INFINITY,
  );
  const lastRequestEnd = entries.reduce(
    (max, e) => Math.max(max, e.startTimeMs + e.durationMs),
    0,
  );
  const criticalPathMs = lastRequestEnd - (Number.isFinite(firstRequestStart) ? firstRequestStart : 0);

  return {
    entries,
    summary: {
      totalRequests: entries.length,
      totalBytes,
      firstRequestStart: Number.isFinite(firstRequestStart) ? firstRequestStart : 0,
      lastRequestEnd,
      criticalPathMs: Math.max(0, criticalPathMs),
    },
  };
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx++;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIdx]}`;
}

function formatMs(ms: number): string {
  if (ms < 1) return `${Math.round(ms * 1000) / 1000} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function statusClass(status: number): string {
  if (status >= 400 || status === 0) return 'status-err';
  if (status >= 300) return 'status-warn';
  if (status >= 200) return 'status-ok';
  return 'status-info';
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    const name = path.length > 1 ? path : parsed.host;
    return name.length > 80 ? `${name.slice(0, 77)}...` : name;
  } catch {
    return url.length > 80 ? `${url.slice(0, 77)}...` : url;
  }
}

interface Segment {
  key: string;
  label: string;
  color: string;
}

const SEGMENTS: Segment[] = [
  { key: 'blocked', label: 'Blocked', color: '#94A3B8' },
  { key: 'dns', label: 'DNS', color: '#8B5CF6' },
  { key: 'connect', label: 'Connect', color: '#6366F1' },
  { key: 'ssl', label: 'SSL', color: '#0EA5E9' },
  { key: 'send', label: 'Send', color: '#10B981' },
  { key: 'wait', label: 'Wait', color: '#F59E0B' },
  { key: 'receive', label: 'Receive', color: '#3B82F6' },
];

function renderWaterfallBar(entry: HarWaterfallEntry, totalMs: number): string {
  const safeTotal = totalMs > 0 ? totalMs : 1;
  const startPct = (entry.startTimeMs / safeTotal) * 100;
  const pieces: string[] = [];
  let cursor = entry.startTimeMs;
  for (const seg of SEGMENTS) {
    const val = entry.timings[seg.key as keyof HarWaterfallEntry['timings']];
    if (val === undefined || val <= 0) continue;
    const left = (cursor / safeTotal) * 100;
    const width = (val / safeTotal) * 100;
    pieces.push(
      `<span class="seg" title="${escapeHtml(seg.label)}: ${formatMs(val)}" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%;background:${seg.color};"></span>`,
    );
    cursor += val;
  }
  if (pieces.length === 0) {
    const width = (entry.durationMs / safeTotal) * 100;
    pieces.push(
      `<span class="seg" title="Duration: ${formatMs(entry.durationMs)}" style="left:${startPct.toFixed(3)}%;width:${width.toFixed(3)}%;background:#3B82F6;"></span>`,
    );
  }
  return `<div class="bar">${pieces.join('')}</div>`;
}

function renderSummaryCards(summary: HarWaterfallSummary): string {
  const cards = [
    { label: 'Requests', value: String(summary.totalRequests) },
    { label: 'Total size', value: formatBytes(summary.totalBytes) },
    { label: 'Total time', value: formatMs(summary.lastRequestEnd - summary.firstRequestStart) },
    { label: 'Critical path', value: formatMs(summary.criticalPathMs) },
  ];
  return cards
    .map(
      (c) =>
        `<div class="card"><div class="card-label">${escapeHtml(c.label)}</div><div class="card-value">${escapeHtml(c.value)}</div></div>`,
    )
    .join('');
}

function renderLegend(): string {
  return SEGMENTS.map(
    (s) =>
      `<span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span>${escapeHtml(s.label)}</span>`,
  ).join('');
}

function renderRows(entries: HarWaterfallEntry[], totalMs: number): string {
  return entries
    .map((entry, idx) => {
      const cls = statusClass(entry.status);
      const urlDisplay = shortUrl(entry.url);
      const methodCell = escapeHtml(entry.method);
      const statusCell = entry.status === 0 ? 'ERR' : String(entry.status);
      return `<tr data-idx="${idx}" data-url="${escapeHtml(entry.url)}" data-method="${methodCell}" data-status="${entry.status}" data-mime="${escapeHtml(entry.mimeType)}" data-size="${entry.sizeBytes}" data-start="${entry.startTimeMs}" data-duration="${entry.durationMs}">
  <td class="col-idx">${idx + 1}</td>
  <td class="col-method">${methodCell}</td>
  <td class="col-status"><span class="status-pill ${cls}">${escapeHtml(statusCell)}</span></td>
  <td class="col-url" title="${escapeHtml(entry.url)}">${escapeHtml(urlDisplay)}</td>
  <td class="col-mime">${escapeHtml(entry.mimeType)}</td>
  <td class="col-size">${escapeHtml(formatBytes(entry.sizeBytes))}</td>
  <td class="col-duration">${escapeHtml(formatMs(entry.durationMs))}</td>
  <td class="col-wf">${renderWaterfallBar(entry, totalMs)}</td>
</tr>`;
    })
    .join('\n');
}

const STYLES = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #FAFAFA; color: #1D1D1F; font-size: 13px; }
.container { max-width: 1400px; margin: 0 auto; padding: 24px; }
h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.01em; }
.subtitle { color: #6B7280; font-size: 13px; margin-bottom: 24px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px; }
.card { background: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 8px; padding: 14px 16px; box-shadow: 0 1px 2px rgba(17,24,39,0.04); }
.card-label { font-size: 11px; color: #6B7280; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
.card-value { font-size: 20px; font-weight: 600; color: #1D1D1F; }
.legend { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; background: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; }
.legend-item { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #4B5563; }
.legend-dot { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.table-wrap { background: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 2px rgba(17,24,39,0.04); }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
thead th { background: #F9FAFB; border-bottom: 1px solid #E5E7EB; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #6B7280; font-weight: 600; padding: 10px 12px; cursor: pointer; user-select: none; white-space: nowrap; }
thead th.sortable:hover { background: #F3F4F6; color: #1D1D1F; }
thead th .sort-ind { font-size: 10px; color: #9CA3AF; margin-left: 4px; }
thead th[data-sorted="asc"] .sort-ind::before { content: "\\25B2"; color: #10B981; }
thead th[data-sorted="desc"] .sort-ind::before { content: "\\25BC"; color: #10B981; }
tbody td { padding: 9px 12px; border-bottom: 1px solid #F3F4F6; font-size: 12px; vertical-align: middle; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover { background: #FAFAFA; }
.col-idx { width: 40px; color: #9CA3AF; }
.col-method { width: 70px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #4B5563; }
.col-status { width: 72px; }
.col-url { max-width: 0; }
.col-mime { width: 140px; color: #6B7280; font-size: 11px; }
.col-size { width: 80px; text-align: right; font-variant-numeric: tabular-nums; color: #4B5563; }
.col-duration { width: 90px; text-align: right; font-variant-numeric: tabular-nums; color: #4B5563; }
.col-wf { width: 40%; padding: 6px 12px; }
.status-pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.status-ok { background: #ECFDF5; color: #047857; border: 1px solid #A7F3D0; }
.status-warn { background: #FEF3C7; color: #92400E; border: 1px solid #FDE68A; }
.status-err { background: #FEE2E2; color: #B91C1C; border: 1px solid #FECACA; }
.status-info { background: #EFF6FF; color: #1D4ED8; border: 1px solid #BFDBFE; }
.bar { position: relative; height: 14px; background: #F3F4F6; border-radius: 3px; overflow: hidden; }
.seg { position: absolute; top: 0; bottom: 0; border-radius: 1px; }
.empty { padding: 48px; text-align: center; color: #6B7280; }
footer { margin-top: 16px; text-align: right; color: #9CA3AF; font-size: 11px; }
`;

const SCRIPT = `
(function(){
  var table = document.querySelector('table');
  if (!table) return;
  var headers = table.querySelectorAll('th.sortable');
  var tbody = table.tBodies[0];
  if (!tbody) return;
  var originalRows = Array.prototype.slice.call(tbody.rows);
  var activeKey = null;
  var activeDir = 'asc';
  function getVal(row, key, type) {
    var v = row.getAttribute('data-' + key) || '';
    if (type === 'num') { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
    return v.toLowerCase();
  }
  function clearIndicators() {
    for (var i = 0; i < headers.length; i++) headers[i].removeAttribute('data-sorted');
  }
  function sortBy(key, type, dir) {
    var rows = Array.prototype.slice.call(tbody.rows);
    rows.sort(function(a, b) {
      var av = getVal(a, key, type); var bv = getVal(b, key, type);
      if (av < bv) return dir === 'asc' ? -1 : 1;
      if (av > bv) return dir === 'asc' ? 1 : -1;
      return 0;
    });
    for (var i = 0; i < rows.length; i++) tbody.appendChild(rows[i]);
  }
  function resetOrder() {
    for (var i = 0; i < originalRows.length; i++) tbody.appendChild(originalRows[i]);
  }
  for (var i = 0; i < headers.length; i++) {
    (function(h){
      h.addEventListener('click', function(){
        var key = h.getAttribute('data-key');
        var type = h.getAttribute('data-type') || 'str';
        if (!key) return;
        if (activeKey === key) {
          if (activeDir === 'asc') { activeDir = 'desc'; }
          else { activeKey = null; activeDir = 'asc'; clearIndicators(); resetOrder(); return; }
        } else {
          activeKey = key; activeDir = 'asc';
        }
        clearIndicators();
        h.setAttribute('data-sorted', activeDir);
        sortBy(activeKey, type, activeDir);
      });
    })(headers[i]);
  }
})();
`;

export function renderWaterfallHtml(
  report: HarWaterfallReport,
  opts?: { title?: string },
): string {
  const title = opts?.title ?? 'HAR waterfall';
  const totalMs = Math.max(1, report.summary.lastRequestEnd);
  const body =
    report.entries.length === 0
      ? '<div class="empty">No requests found in HAR file.</div>'
      : `<div class="table-wrap"><table>
<colgroup>
<col style="width:40px"><col style="width:70px"><col style="width:72px"><col><col style="width:140px"><col style="width:80px"><col style="width:90px"><col style="width:40%">
</colgroup>
<thead><tr>
<th class="sortable" data-key="idx" data-type="num">#<span class="sort-ind"></span></th>
<th class="sortable" data-key="method" data-type="str">Method<span class="sort-ind"></span></th>
<th class="sortable" data-key="status" data-type="num">Status<span class="sort-ind"></span></th>
<th class="sortable" data-key="url" data-type="str">URL<span class="sort-ind"></span></th>
<th class="sortable" data-key="mime" data-type="str">Type<span class="sort-ind"></span></th>
<th class="sortable" data-key="size" data-type="num">Size<span class="sort-ind"></span></th>
<th class="sortable" data-key="duration" data-type="num">Time<span class="sort-ind"></span></th>
<th class="sortable" data-key="start" data-type="num">Waterfall<span class="sort-ind"></span></th>
</tr></thead>
<tbody>
${renderRows(report.entries, totalMs)}
</tbody></table></div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="container">
<h1>${escapeHtml(title)}</h1>
<div class="subtitle">${report.summary.totalRequests} requests - ${escapeHtml(formatBytes(report.summary.totalBytes))} - ${escapeHtml(formatMs(report.summary.criticalPathMs))} critical path</div>
<div class="cards">${renderSummaryCards(report.summary)}</div>
<div class="legend">${renderLegend()}</div>
${body}
<footer>Generated by uxinspect - har-waterfall</footer>
</div>
<script>${SCRIPT}</script>
</body>
</html>`;
}

export async function writeWaterfallHtml(
  harPath: string,
  outPath: string,
  opts?: { title?: string },
): Promise<void> {
  const content = await readFile(harPath, 'utf8');
  const report = parseHar(content);
  const html = renderWaterfallHtml(report, opts);
  await writeFile(outPath, html, 'utf8');
}
