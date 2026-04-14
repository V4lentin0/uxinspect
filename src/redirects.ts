export interface RedirectHop {
  url: string;
  status: number;
  location?: string;
  method: string;
  durationMs: number;
}

export interface RedirectAuditOptions {
  maxHops?: number;
  timeoutMs?: number;
  method?: 'GET' | 'HEAD';
}

export interface RedirectAuditResult {
  start: string;
  final: string;
  hops: RedirectHop[];
  hopCount: number;
  loop: boolean;
  mixedScheme: boolean;
  metaRefresh: boolean;
  passed: boolean;
}

const META_REFRESH_RE = /<meta\s+http-equiv=["']?refresh["']?\s+content=["']?\s*\d+\s*;\s*url=([^"'>\s]+)/i;

function resolveLocation(base: string, loc: string): string {
  try {
    return new URL(loc, base).toString();
  } catch {
    return loc;
  }
}

async function fetchWithTimeout(url: string, method: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { method, redirect: 'manual', signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function auditRedirects(url: string, opts: RedirectAuditOptions = {}): Promise<RedirectAuditResult> {
  const maxHops = opts.maxHops ?? 10;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const initialMethod = opts.method ?? 'HEAD';

  const hops: RedirectHop[] = [];
  const visited = new Set<string>();
  let current = url;
  let loop = false;
  let mixedScheme = false;
  let metaRefresh = false;
  let prevScheme = new URL(url).protocol;
  let finalStatus = 0;
  let currentMethod = initialMethod;

  for (let i = 0; i < maxHops; i++) {
    if (visited.has(current)) {
      loop = true;
      break;
    }
    visited.add(current);

    const scheme = new URL(current).protocol;
    if (scheme !== prevScheme) mixedScheme = true;
    prevScheme = scheme;

    const started = Date.now();
    let res: Response;
    try {
      res = await fetchWithTimeout(current, currentMethod, timeoutMs);
    } catch {
      hops.push({ url: current, status: 0, method: currentMethod, durationMs: Date.now() - started });
      finalStatus = 0;
      break;
    }

    if ((res.status === 405 || res.status === 501) && currentMethod === 'HEAD') {
      currentMethod = 'GET';
      try {
        res = await fetchWithTimeout(current, currentMethod, timeoutMs);
      } catch {
        hops.push({ url: current, status: 0, method: currentMethod, durationMs: Date.now() - started });
        finalStatus = 0;
        break;
      }
    }

    const location = res.headers.get('location') ?? undefined;
    const hop: RedirectHop = {
      url: current,
      status: res.status,
      location: location ? resolveLocation(current, location) : undefined,
      method: currentMethod,
      durationMs: Date.now() - started,
    };
    hops.push(hop);
    finalStatus = res.status;

    if (res.status >= 300 && res.status < 400 && hop.location) {
      current = hop.location;
      continue;
    }

    if (res.status === 200 && currentMethod === 'GET') {
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('text/html')) {
        try {
          const body = await res.text();
          const m = body.match(META_REFRESH_RE);
          if (m && m[1]) {
            metaRefresh = true;
            const next = resolveLocation(current, m[1]);
            if (!visited.has(next) && hops.length < maxHops) {
              current = next;
              continue;
            }
            if (visited.has(next)) loop = true;
          }
        } catch {
          // body read failed; treat as terminal
        }
      }
    }
    break;
  }

  const schemeDowngrade = hops.some((h, i) => {
    if (i === 0) return false;
    return hops[i - 1].url.startsWith('https://') && h.url.startsWith('http://');
  });

  const passed = hops.length <= 3 && !loop && !schemeDowngrade && finalStatus === 200;

  return {
    start: url,
    final: hops.length ? hops[hops.length - 1].url : url,
    hops,
    hopCount: hops.length,
    loop,
    mixedScheme,
    metaRefresh,
    passed,
  };
}
