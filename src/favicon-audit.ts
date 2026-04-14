import type { Page, APIResponse } from 'playwright';

export interface FaviconEntry {
  rel: string;
  href: string;
  sizes?: string;
  type?: string;
  status?: number;
  contentType?: string;
  contentLengthBytes?: number;
  exists: boolean;
  actualWidth?: number;
  actualHeight?: number;
}

export interface FaviconIssue {
  kind:
    | 'missing-favicon' | 'favicon-404' | 'missing-apple-touch'
    | 'missing-manifest-icon' | 'wrong-mime' | 'too-small'
    | 'not-square' | 'root-favicon-ico-missing' | 'manifest-not-fetchable';
  href?: string;
  detail: string;
}

export interface FaviconAuditResult {
  page: string;
  icons: FaviconEntry[];
  manifestIcons: FaviconEntry[];
  rootFaviconIco: FaviconEntry | null;
  issues: FaviconIssue[];
  passed: boolean;
}

interface LinkRecord { rel: string; href: string; sizes?: string; type?: string; }
interface ManifestIcon { src: string; sizes?: string; type?: string; }
interface Dims { w: number; h: number; }

const MAX_SIZE_SAMPLES = 5;
const REQUEST_TIMEOUT_MS = 10_000;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function parseSizesAttr(sizes: string | undefined): Dims[] {
  if (!sizes) return [];
  const out: Dims[] = [];
  for (const token of sizes.split(/\s+/).filter((t) => t.length > 0)) {
    if (token.toLowerCase() === 'any') continue;
    const m = /^(\d+)x(\d+)$/i.exec(token);
    if (m) {
      const w = Number.parseInt(m[1], 10);
      const h = Number.parseInt(m[2], 10);
      if (Number.isFinite(w) && Number.isFinite(h)) out.push({ w, h });
    }
  }
  return out;
}

function extFromPath(urlStr: string): string {
  try {
    const path = new URL(urlStr).pathname.toLowerCase();
    const dot = path.lastIndexOf('.');
    return dot >= 0 ? path.slice(dot + 1) : '';
  } catch { return ''; }
}

function mimeMatches(declared: string, actual: string | undefined): boolean {
  if (!actual) return true;
  const d = declared.toLowerCase().trim();
  const a = actual.toLowerCase().split(';')[0].trim();
  if (d === a) return true;
  if ((d === 'image/jpg' && a === 'image/jpeg') || (d === 'image/jpeg' && a === 'image/jpg')) return true;
  return false;
}

function readPngSize(buf: Buffer): Dims | null {
  if (buf.length < 24) return null;
  for (let i = 0; i < PNG_SIG.length; i++) if (buf[i] !== PNG_SIG[i]) return null;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w === 0 || h === 0) return null;
  return { w, h };
}

function readJpegSize(buf: Buffer): Dims | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length - 8) {
    if (buf[i] !== 0xff) { i++; continue; }
    let marker = buf[i + 1];
    while (marker === 0xff && i + 1 < buf.length) { i++; marker = buf[i + 1]; }
    i += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (i + 2 > buf.length) return null;
    const segLen = buf.readUInt16BE(i);
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      if (i + 7 > buf.length) return null;
      const h = buf.readUInt16BE(i + 3);
      const w = buf.readUInt16BE(i + 5);
      if (w === 0 || h === 0) return null;
      return { w, h };
    }
    i += segLen;
  }
  return null;
}

function detectSize(buf: Buffer, ct: string | undefined): Dims | null {
  const c = (ct ?? '').toLowerCase();
  if (c.includes('png')) return readPngSize(buf);
  if (c.includes('jpeg') || c.includes('jpg')) return readJpegSize(buf);
  return readPngSize(buf) ?? readJpegSize(buf);
}

async function collectLinks(page: Page): Promise<LinkRecord[]> {
  return await page.evaluate(() => {
    const rels = ['icon', 'apple-touch-icon', 'mask-icon', 'shortcut icon', 'manifest'];
    const out: Array<{ rel: string; href: string; sizes?: string; type?: string }> = [];
    const links = Array.from(document.querySelectorAll('link')) as HTMLLinkElement[];
    for (const link of links) {
      const relRaw = (link.getAttribute('rel') ?? '').trim().toLowerCase();
      if (!relRaw) continue;
      const href = link.getAttribute('href');
      if (!href) continue;
      const match = rels.find((r) => relRaw === r || relRaw.split(/\s+/).includes(r));
      if (!match) continue;
      const rec: { rel: string; href: string; sizes?: string; type?: string } = { rel: match, href };
      const sizes = link.getAttribute('sizes');
      if (sizes) rec.sizes = sizes;
      const type = link.getAttribute('type');
      if (type) rec.type = type;
      out.push(rec);
    }
    return out;
  });
}

function resolveAbs(href: string, base: string): string | null {
  try { return new URL(href, base).toString(); } catch { return null; }
}

async function fetchResource(page: Page, url: string): Promise<APIResponse | null> {
  try {
    return await page.request.get(url, {
      timeout: REQUEST_TIMEOUT_MS, failOnStatusCode: false, maxRedirects: 5,
    });
  } catch { return null; }
}

function applyHeaders(entry: FaviconEntry, res: APIResponse): void {
  entry.status = res.status();
  const headers = res.headers();
  const ct = headers['content-type'];
  if (ct) entry.contentType = ct;
  const clen = headers['content-length'];
  if (clen) {
    const n = Number.parseInt(clen, 10);
    if (Number.isFinite(n) && n >= 0) entry.contentLengthBytes = n;
  }
  entry.exists = res.ok();
}

async function populateEntry(
  page: Page, entry: FaviconEntry, sampleBudget: { remaining: number },
): Promise<void> {
  const res = await fetchResource(page, entry.href);
  if (!res) { entry.exists = false; return; }
  applyHeaders(entry, res);
  if (!entry.exists) return;

  const ct = entry.contentType;
  const ext = extFromPath(entry.href);
  const ctLower = (ct ?? '').toLowerCase();
  const sizable =
    ctLower.includes('png') || ctLower.includes('jpeg') || ctLower.includes('jpg') ||
    (!ct && (ext === 'png' || ext === 'jpg' || ext === 'jpeg'));
  if (!sizable || sampleBudget.remaining <= 0) return;
  sampleBudget.remaining--;

  try {
    const body = await res.body();
    if (entry.contentLengthBytes === undefined) entry.contentLengthBytes = body.byteLength;
    const dims = detectSize(body, ct);
    if (dims) { entry.actualWidth = dims.w; entry.actualHeight = dims.h; }
  } catch { /* body unavailable */ }
}

async function fetchManifest(
  page: Page, manifestUrl: string,
): Promise<{ icons: ManifestIcon[] } | null> {
  const res = await fetchResource(page, manifestUrl);
  if (!res || !res.ok()) return null;
  let text: string;
  try { text = await res.text(); } catch { return null; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const raw = (parsed as { icons?: unknown }).icons;
  if (!Array.isArray(raw)) return { icons: [] };
  const icons: ManifestIcon[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const src = (item as { src?: unknown }).src;
    if (typeof src !== 'string' || src.length === 0) continue;
    const icon: ManifestIcon = { src };
    const sizes = (item as { sizes?: unknown }).sizes;
    if (typeof sizes === 'string') icon.sizes = sizes;
    const type = (item as { type?: unknown }).type;
    if (typeof type === 'string') icon.type = type;
    icons.push(icon);
  }
  return { icons };
}

function evaluateEntry(entry: FaviconEntry, issues: FaviconIssue[]): void {
  if (!entry.exists) {
    issues.push({
      kind: 'favicon-404', href: entry.href,
      detail: `${entry.rel} returned ${entry.status ?? 'no response'}`,
    });
    return;
  }
  if (entry.type && !mimeMatches(entry.type, entry.contentType)) {
    issues.push({
      kind: 'wrong-mime', href: entry.href,
      detail: `declared type "${entry.type}" but server returned "${entry.contentType ?? 'unknown'}"`,
    });
  }
  if (entry.actualWidth !== undefined && entry.actualHeight !== undefined) {
    if (entry.actualWidth !== entry.actualHeight) {
      issues.push({
        kind: 'not-square', href: entry.href,
        detail: `${entry.actualWidth}x${entry.actualHeight} is not square`,
      });
    }
    for (const d of parseSizesAttr(entry.sizes)) {
      if (entry.actualWidth < d.w || entry.actualHeight < d.h) {
        issues.push({
          kind: 'too-small', href: entry.href,
          detail: `actual ${entry.actualWidth}x${entry.actualHeight} smaller than declared ${d.w}x${d.h}`,
        });
        break;
      }
    }
  }
}

function buildEntry(rel: string, href: string, link: Partial<LinkRecord>): FaviconEntry {
  const entry: FaviconEntry = { rel, href, exists: false };
  if (link.sizes) entry.sizes = link.sizes;
  if (link.type) entry.type = link.type;
  return entry;
}

export async function auditFavicons(page: Page): Promise<FaviconAuditResult> {
  const pageUrl = page.url();
  const issues: FaviconIssue[] = [];
  const icons: FaviconEntry[] = [];
  const manifestIcons: FaviconEntry[] = [];
  let rootFaviconIco: FaviconEntry | null = null;

  const links = await collectLinks(page);
  const sampleBudget = { remaining: MAX_SIZE_SAMPLES };
  const manifestLinks: LinkRecord[] = [];
  const iconLinks: LinkRecord[] = [];
  for (const link of links) {
    if (link.rel === 'manifest') manifestLinks.push(link);
    else iconLinks.push(link);
  }

  for (const link of iconLinks) {
    const abs = resolveAbs(link.href, pageUrl);
    if (!abs) continue;
    const entry = buildEntry(link.rel, abs, link);
    await populateEntry(page, entry, sampleBudget);
    icons.push(entry);
  }

  let manifestFetched = false;
  let manifestHadIcons = false;
  for (const link of manifestLinks) {
    const abs = resolveAbs(link.href, pageUrl);
    if (!abs) continue;
    const parsed = await fetchManifest(page, abs);
    if (!parsed) {
      issues.push({
        kind: 'manifest-not-fetchable', href: abs,
        detail: 'manifest link declared but JSON could not be fetched or parsed',
      });
      continue;
    }
    manifestFetched = true;
    if (parsed.icons.length > 0) manifestHadIcons = true;
    for (const icon of parsed.icons) {
      const iconAbs = resolveAbs(icon.src, abs);
      if (!iconAbs) continue;
      const entry = buildEntry('manifest', iconAbs, icon);
      await populateEntry(page, entry, sampleBudget);
      manifestIcons.push(entry);
    }
  }

  const rootIcoUrl = resolveAbs('/favicon.ico', pageUrl);
  if (rootIcoUrl) {
    const entry: FaviconEntry = { rel: 'icon', href: rootIcoUrl, exists: false };
    const res = await fetchResource(page, rootIcoUrl);
    if (res) applyHeaders(entry, res);
    rootFaviconIco = entry;
  }

  const hasIconLink = iconLinks.some((l) => l.rel === 'icon' || l.rel === 'shortcut icon');
  const hasAppleTouch = iconLinks.some((l) => l.rel === 'apple-touch-icon');
  const hasManifest = manifestLinks.length > 0;
  const rootIcoExists = rootFaviconIco?.exists ?? false;

  if (!hasIconLink && !hasAppleTouch && !hasManifest && !rootIcoExists) {
    issues.push({
      kind: 'missing-favicon',
      detail: 'no <link rel="icon">, apple-touch-icon, manifest, or /favicon.ico found',
    });
  }

  for (const entry of icons) evaluateEntry(entry, issues);
  for (const entry of manifestIcons) evaluateEntry(entry, issues);

  if (!hasAppleTouch) {
    issues.push({ kind: 'missing-apple-touch', detail: 'no <link rel="apple-touch-icon"> declared' });
  }
  if (hasManifest && manifestFetched && !manifestHadIcons) {
    issues.push({ kind: 'missing-manifest-icon', detail: 'manifest was fetched but declares no icons[]' });
  }
  if (rootFaviconIco && !rootFaviconIco.exists) {
    issues.push({
      kind: 'root-favicon-ico-missing', href: rootFaviconIco.href,
      detail: `/favicon.ico returned ${rootFaviconIco.status ?? 'no response'}`,
    });
  }

  const fatal = new Set<FaviconIssue['kind']>([
    'missing-favicon', 'favicon-404', 'manifest-not-fetchable',
  ]);
  const passed = !issues.some((i) => fatal.has(i.kind));

  return { page: pageUrl, icons, manifestIcons, rootFaviconIco, issues, passed };
}
