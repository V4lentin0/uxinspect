/**
 * Heatmap overlay for auto-explore runs.
 *
 * Records real coordinates (x/y/w/h) of clickable elements discovered during
 * BFS exploration and renders them as an SVG overlay classified by outcome:
 *   - clicked   = green  (#10B981)
 *   - untested  = red    (#EF4444)
 *   - hoverOnly = amber  (#F59E0B)
 *
 * The SVG uses a viewBox matching the viewport so it can scale cleanly when
 * embedded in the HTML report, and optionally references the run screenshot
 * as a background layer.
 */

export interface HeatmapRect {
  x: number;
  y: number;
  w: number;
  h: number;
  selector: string;
}

export interface ClickRecord extends HeatmapRect {
  /** Whether the click completed (target was actually clicked) or failed. */
  result: 'clicked' | 'failed';
}

export interface UntestedRecord extends HeatmapRect {}

export interface HoverOnlyRecord extends HeatmapRect {}

export interface HeatmapViewport {
  name: string;
  width: number;
  height: number;
}

export interface HeatmapData {
  viewport: HeatmapViewport;
  clicks: ClickRecord[];
  untested: UntestedRecord[];
  hoverOnly?: HoverOnlyRecord[];
  /** Optional data URL or relative path for the background screenshot. */
  screenshotUrl?: string;
}

export const HEATMAP_COLORS = {
  clicked: '#10B981',
  untested: '#EF4444',
  hoverOnly: '#F59E0B',
} as const;

/**
 * Append a clicked-element record to the provided log. Mutates in place so
 * callers can share a single list across a BFS iteration without needing to
 * stitch results back together.
 */
export function logClick(
  log: ClickRecord[],
  entry: {
    x: number;
    y: number;
    w: number;
    h: number;
    selector: string;
    result: 'clicked' | 'failed';
  },
): void {
  if (!Number.isFinite(entry.x) || !Number.isFinite(entry.y)) return;
  if (!Number.isFinite(entry.w) || !Number.isFinite(entry.h)) return;
  if (entry.w <= 0 || entry.h <= 0) return;
  log.push({
    x: entry.x,
    y: entry.y,
    w: entry.w,
    h: entry.h,
    selector: entry.selector,
    result: entry.result,
  });
}

/**
 * Append an untested (visible but skipped) interactive element to the log.
 */
export function logUntested(
  log: UntestedRecord[],
  entry: { x: number; y: number; w: number; h: number; selector: string },
): void {
  if (!Number.isFinite(entry.x) || !Number.isFinite(entry.y)) return;
  if (!Number.isFinite(entry.w) || !Number.isFinite(entry.h)) return;
  if (entry.w <= 0 || entry.h <= 0) return;
  log.push({
    x: entry.x,
    y: entry.y,
    w: entry.w,
    h: entry.h,
    selector: entry.selector,
  });
}

function escape(s: string): string {
  return (s ?? '')
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderRect(
  r: HeatmapRect,
  fill: string,
  stroke: string,
  title: string,
): string {
  const x = Math.max(0, Math.round(r.x));
  const y = Math.max(0, Math.round(r.y));
  const w = Math.max(1, Math.round(r.w));
  const h = Math.max(1, Math.round(r.h));
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" ry="4" ` +
    `fill="${fill}" fill-opacity="0.6" stroke="${stroke}" stroke-width="1" stroke-opacity="0.9">` +
    `<title>${escape(title)}</title></rect>`
  );
}

/**
 * Render a heatmap as an inline SVG string. Returns a full `<svg>` element
 * with a viewBox set to the viewport dimensions so the browser scales it to
 * fit any container (preserveAspectRatio="xMidYMid meet").
 */
export function renderHeatmapSVG(data: HeatmapData): string {
  const { viewport, clicks, untested } = data;
  const hoverOnly = data.hoverOnly ?? [];
  const vw = Math.max(1, Math.round(viewport.width));
  const vh = Math.max(1, Math.round(viewport.height));

  const bg = data.screenshotUrl
    ? `<image href="${escape(data.screenshotUrl)}" x="0" y="0" width="${vw}" height="${vh}" preserveAspectRatio="xMidYMin meet"/>`
    : `<rect x="0" y="0" width="${vw}" height="${vh}" fill="#FAFAFA"/>`;

  const clickedRects = clicks
    .filter((c) => c.result === 'clicked')
    .map((c) =>
      renderRect(c, HEATMAP_COLORS.clicked, HEATMAP_COLORS.clicked, `clicked: ${c.selector}`),
    )
    .join('');
  const failedRects = clicks
    .filter((c) => c.result === 'failed')
    .map((c) =>
      renderRect(c, HEATMAP_COLORS.untested, HEATMAP_COLORS.untested, `failed: ${c.selector}`),
    )
    .join('');
  const untestedRects = untested
    .map((u) =>
      renderRect(u, HEATMAP_COLORS.untested, HEATMAP_COLORS.untested, `untested: ${u.selector}`),
    )
    .join('');
  const hoverRects = hoverOnly
    .map((h) =>
      renderRect(h, HEATMAP_COLORS.hoverOnly, HEATMAP_COLORS.hoverOnly, `hover-only: ${h.selector}`),
    )
    .join('');

  const legendY = vh - 36;
  const legend =
    `<g font-family="Inter, system-ui, sans-serif" font-size="12" fill="#1D1D1F">` +
    `<rect x="8" y="${legendY}" width="${Math.min(vw - 16, 420)}" height="28" rx="6" ry="6" fill="#FFFFFF" fill-opacity="0.92" stroke="#E5E7EB"/>` +
    `<rect x="16" y="${legendY + 8}" width="12" height="12" rx="2" fill="${HEATMAP_COLORS.clicked}" fill-opacity="0.6" stroke="${HEATMAP_COLORS.clicked}"/>` +
    `<text x="34" y="${legendY + 18}">Clicked (${clicks.filter((c) => c.result === 'clicked').length})</text>` +
    `<rect x="130" y="${legendY + 8}" width="12" height="12" rx="2" fill="${HEATMAP_COLORS.untested}" fill-opacity="0.6" stroke="${HEATMAP_COLORS.untested}"/>` +
    `<text x="148" y="${legendY + 18}">Untested (${untested.length + clicks.filter((c) => c.result === 'failed').length})</text>` +
    (hoverOnly.length
      ? `<rect x="260" y="${legendY + 8}" width="12" height="12" rx="2" fill="${HEATMAP_COLORS.hoverOnly}" fill-opacity="0.6" stroke="${HEATMAP_COLORS.hoverOnly}"/>` +
        `<text x="278" y="${legendY + 18}">Hover-only (${hoverOnly.length})</text>`
      : '') +
    `</g>`;

  const label =
    `<g font-family="Inter, system-ui, sans-serif" font-size="11" fill="#1D1D1F">` +
    `<text x="8" y="16">${escape(viewport.name)} · ${vw}×${vh}</text>` +
    `</g>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw} ${vh}" ` +
    `preserveAspectRatio="xMidYMid meet" width="100%" style="max-width:100%;height:auto;border:1px solid #E5E7EB;border-radius:6px;background:#FAFAFA">` +
    bg +
    clickedRects +
    failedRects +
    untestedRects +
    hoverRects +
    label +
    legend +
    `</svg>`
  );
}

/**
 * Convenience helper: capture a Playwright bounding box and return it as a
 * HeatmapRect, or null if the element isn't laid out. Kept here so the
 * explore module doesn't need to know about the shape.
 */
export async function captureBoundingBox(
  locator: { boundingBox: () => Promise<{ x: number; y: number; width: number; height: number } | null> },
  selector: string,
): Promise<HeatmapRect | null> {
  try {
    const box = await locator.boundingBox();
    if (!box) return null;
    if (box.width <= 0 || box.height <= 0) return null;
    return { x: box.x, y: box.y, w: box.width, h: box.height, selector };
  } catch {
    return null;
  }
}
