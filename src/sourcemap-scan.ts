import type { Page, APIResponse } from 'playwright';

export type SourceMapSourceKind = 'directive-comment' | 'http-header' | 'filename-convention';

export interface SourceMapLeak {
  assetUrl: string;
  mapUrl: string;
  reachable: boolean;
  contentType?: string;
  sizeBytes?: number;
  fileCount?: number;
  sampleSources?: string[];
  sourceKind: SourceMapSourceKind;
}

export interface SourceMapScanResult {
  page: string;
  assetsScanned: number;
  leaks: SourceMapLeak[];
  passed: boolean;
}

export interface SourceMapScanOptions {
  maxAssets?: number;
  includeCss?: boolean;
}

interface ResourceEntry {
  name: string;
  initiatorType: string;
}

interface DiscoveredMap {
  mapUrl: string;
  sourceKind: SourceMapSourceKind;
}

interface SourceMapPayload {
  sources?: unknown;
}

const DEFAULT_MAX_ASSETS = 30;
const REQUEST_TIMEOUT_MS = 10_000;
const TAIL_BYTES = 500;
const SAMPLE_SOURCES_LIMIT = 5;
const SAMPLE_SOURCE_TRIM = 80;
const MAP_FILENAME_SUFFIX = '.map';

function isFetchableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function classifyAsset(entry: ResourceEntry, includeCss: boolean): 'js' | 'css' | null {
  let pathname = '';
  try {
    pathname = new URL(entry.name).pathname.toLowerCase();
  } catch {
    pathname = entry.name.toLowerCase();
  }
  if (pathname.endsWith('.js') || pathname.endsWith('.mjs') || pathname.endsWith('.cjs')) return 'js';
  if (includeCss && pathname.endsWith('.css')) return 'css';
  return null;
}

function resolveMapUrl(assetUrl: string, mapRef: string): string | null {
  const trimmed = mapRef.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase().startsWith('data:')) return trimmed;
  try {
    return new URL(trimmed, assetUrl).toString();
  } catch {
    return null;
  }
}

function extractDirectiveComment(tail: string): string | null {
  const jsMatch = tail.match(/\/\/[#@]\s*sourceMappingURL=([^\s'"<>]+)\s*$/m);
  if (jsMatch && jsMatch[1]) return jsMatch[1];
  const cssMatch = tail.match(/\/\*[#@]\s*sourceMappingURL=([^\s'"<>]+)\s*\*\//m);
  if (cssMatch && cssMatch[1]) return cssMatch[1];
  return null;
}

function extractHeaderMapRef(headers: Record<string, string>): string | null {
  const candidate = headers['sourcemap'] ?? headers['x-sourcemap'];
  if (!candidate) return null;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseSizeHeader(headers: Record<string, string>): number | undefined {
  const raw = headers['content-length'];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function trimSourcePath(value: string): string {
  if (value.length <= SAMPLE_SOURCE_TRIM) return value;
  return value.slice(0, SAMPLE_SOURCE_TRIM);
}

function parseMapPayload(body: string): { fileCount?: number; sampleSources?: string[] } {
  let parsed: SourceMapPayload;
  try {
    parsed = JSON.parse(body) as SourceMapPayload;
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sources)) return {};
  const sources: string[] = [];
  for (const raw of parsed.sources) {
    if (typeof raw === 'string') sources.push(raw);
  }
  const sampleSources = sources.slice(0, SAMPLE_SOURCES_LIMIT).map(trimSourcePath);
  return { fileCount: sources.length, sampleSources };
}

async function fetchText(
  page: Page,
  url: string,
): Promise<{ body: string; headers: Record<string, string>; ok: boolean } | null> {
  try {
    const res: APIResponse = await page.request.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      failOnStatusCode: false,
    });
    const headers = res.headers();
    if (!res.ok()) return { body: '', headers, ok: false };
    const body = await res.text();
    return { body, headers, ok: true };
  } catch {
    return null;
  }
}

async function headLikeRequest(
  page: Page,
  url: string,
): Promise<{ headers: Record<string, string>; ok: boolean; status: number } | null> {
  try {
    const res: APIResponse = await page.request.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      failOnStatusCode: false,
      headers: { Range: 'bytes=0-0' },
    });
    return { headers: res.headers(), ok: res.ok() || res.status() === 206, status: res.status() };
  } catch {
    return null;
  }
}

async function inspectMap(
  page: Page,
  assetUrl: string,
  mapUrl: string,
  sourceKind: SourceMapSourceKind,
): Promise<SourceMapLeak | null> {
  if (mapUrl.toLowerCase().startsWith('data:')) return null;

  const fetched = await fetchText(page, mapUrl);
  if (!fetched) {
    return {
      assetUrl,
      mapUrl,
      reachable: false,
      sourceKind,
    };
  }
  if (!fetched.ok) {
    return {
      assetUrl,
      mapUrl,
      reachable: false,
      contentType: fetched.headers['content-type'],
      sourceKind,
    };
  }

  const contentType = fetched.headers['content-type'];
  const headerSize = parseSizeHeader(fetched.headers);
  const sizeBytes = headerSize ?? Buffer.byteLength(fetched.body, 'utf8');
  const { fileCount, sampleSources } = parseMapPayload(fetched.body);

  return {
    assetUrl,
    mapUrl,
    reachable: true,
    contentType,
    sizeBytes,
    fileCount,
    sampleSources,
    sourceKind,
  };
}

async function discoverForAsset(page: Page, assetUrl: string): Promise<DiscoveredMap[]> {
  const found: DiscoveredMap[] = [];
  const seen = new Set<string>();

  const assetRes = await fetchText(page, assetUrl);
  if (assetRes && assetRes.ok) {
    const headerRef = extractHeaderMapRef(assetRes.headers);
    if (headerRef) {
      const resolved = resolveMapUrl(assetUrl, headerRef);
      if (resolved && !seen.has(resolved)) {
        seen.add(resolved);
        found.push({ mapUrl: resolved, sourceKind: 'http-header' });
      }
    }
    const tail = assetRes.body.slice(Math.max(0, assetRes.body.length - TAIL_BYTES));
    const directiveRef = extractDirectiveComment(tail);
    if (directiveRef) {
      const resolved = resolveMapUrl(assetUrl, directiveRef);
      if (resolved && !seen.has(resolved)) {
        seen.add(resolved);
        found.push({ mapUrl: resolved, sourceKind: 'directive-comment' });
      }
    }
  }

  const conventionUrl = assetUrl + MAP_FILENAME_SUFFIX;
  if (!seen.has(conventionUrl)) {
    const head = await headLikeRequest(page, conventionUrl);
    if (head && head.ok) {
      seen.add(conventionUrl);
      found.push({ mapUrl: conventionUrl, sourceKind: 'filename-convention' });
    }
  }

  return found;
}

export async function scanSourceMaps(
  page: Page,
  opts?: SourceMapScanOptions,
): Promise<SourceMapScanResult> {
  const maxAssets = opts?.maxAssets ?? DEFAULT_MAX_ASSETS;
  const includeCss = opts?.includeCss ?? true;
  const pageUrl = page.url();

  const entries = await page.evaluate((): ResourceEntry[] =>
    (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map((r) => ({
      name: r.name,
      initiatorType: r.initiatorType,
    })),
  );

  const assets: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isFetchableUrl(entry.name)) continue;
    if (seen.has(entry.name)) continue;
    const kind = classifyAsset(entry, includeCss);
    if (!kind) continue;
    seen.add(entry.name);
    assets.push(entry.name);
    if (assets.length >= maxAssets) break;
  }

  const leaks: SourceMapLeak[] = [];
  const leakKeys = new Set<string>();

  for (const assetUrl of assets) {
    const discovered = await discoverForAsset(page, assetUrl);
    for (const d of discovered) {
      const key = `${assetUrl}\u0000${d.mapUrl}`;
      if (leakKeys.has(key)) continue;
      const leak = await inspectMap(page, assetUrl, d.mapUrl, d.sourceKind);
      if (!leak) continue;
      leakKeys.add(key);
      leaks.push(leak);
    }
  }

  return {
    page: pageUrl,
    assetsScanned: assets.length,
    leaks,
    passed: leaks.length === 0,
  };
}
