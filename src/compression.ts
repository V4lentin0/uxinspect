import http2 from 'node:http2';

export interface CompressionAuditResult {
  url: string;
  httpVersion?: 'HTTP/1.0' | 'HTTP/1.1' | 'HTTP/2' | 'HTTP/3' | string;
  contentEncoding?: 'gzip' | 'br' | 'zstd' | 'deflate' | 'identity' | string;
  contentLength?: number;
  transferLength?: number;
  compressionRatio?: number;
  supportsBrotli: boolean;
  altSvcHasH3: boolean;
  issues: string[];
  passed: boolean;
}

async function probeHttp2(origin: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { session.close(); } catch { /* ignore */ }
      resolve(ok);
    };
    const session = http2.connect(origin, {
      rejectUnauthorized: false,
      settings: {},
    });
    const timer = setTimeout(() => done(false), timeoutMs);
    session.on('connect', () => { clearTimeout(timer); done(true); });
    session.on('error', () => { clearTimeout(timer); done(false); });
    session.on('close', () => { clearTimeout(timer); done(settled ? true : false); });
  });
}

function parseAltSvcForH3(altSvc: string | null | undefined): boolean {
  if (!altSvc) return false;
  return /\bh3(?:-\d+)?=/i.test(altSvc);
}

function normalizeEncoding(enc: string | null): string | undefined {
  if (!enc) return undefined;
  const v = enc.trim().toLowerCase();
  return v.length ? v : undefined;
}

function parseIntSafe(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export async function auditCompression(url: string): Promise<CompressionAuditResult> {
  const timeoutMs = 10_000;
  const issues: string[] = [];

  const parsed = new URL(url);
  const origin = `${parsed.protocol}//${parsed.host}`;

  let response: Response | undefined;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept-Encoding': 'br, gzip, zstd, deflate',
        'Accept': '*/*',
        'User-Agent': 'uxinspect/compression-audit',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    issues.push(`request failed: ${(err as Error).message}`);
    return {
      url,
      supportsBrotli: false,
      altSvcHasH3: false,
      issues,
      passed: false,
    };
  }

  const contentEncoding = normalizeEncoding(response.headers.get('content-encoding'));
  const contentLengthHeader = parseIntSafe(response.headers.get('content-length'));
  const altSvc = response.headers.get('alt-svc');
  const altSvcHasH3 = parseAltSvcForH3(altSvc);

  let transferLength: number | undefined;
  let decodedLength: number | undefined;
  try {
    const buf = await response.arrayBuffer();
    decodedLength = buf.byteLength;
  } catch {
    /* ignore body read errors */
  }

  // When fetch auto-decodes, content-length header generally reflects the
  // compressed (transfer) size and the decoded buffer is the uncompressed size.
  if (contentEncoding && contentEncoding !== 'identity') {
    transferLength = contentLengthHeader;
  } else {
    transferLength = contentLengthHeader ?? decodedLength;
  }

  const contentLength = decodedLength ?? contentLengthHeader;

  let compressionRatio: number | undefined;
  if (
    contentLength !== undefined &&
    transferLength !== undefined &&
    transferLength > 0 &&
    contentEncoding &&
    contentEncoding !== 'identity'
  ) {
    compressionRatio = contentLength / transferLength;
  }

  const supportsBrotli = contentEncoding === 'br';

  // HTTP version detection: probe HTTP/2 via node:http2 for https origins.
  let httpVersion: CompressionAuditResult['httpVersion'];
  if (parsed.protocol === 'https:') {
    const h2 = await probeHttp2(origin, Math.min(timeoutMs, 5000));
    if (h2) {
      httpVersion = 'HTTP/2';
    } else {
      // Heuristic: presence of Connection: keep-alive + no h2 => HTTP/1.1.
      const connection = response.headers.get('connection');
      httpVersion = connection ? 'HTTP/1.1' : 'HTTP/1.1';
    }
  } else {
    httpVersion = 'HTTP/1.1';
  }

  if (altSvcHasH3) {
    // Server advertises HTTP/3 availability; report as HTTP/3-capable.
    httpVersion = 'HTTP/3';
  }

  // Issue detection
  if (!contentEncoding || contentEncoding === 'identity') {
    issues.push('no compression');
  } else if (contentEncoding === 'deflate') {
    issues.push('using deflate instead of brotli');
  } else if (contentEncoding === 'gzip') {
    issues.push('gzip in use; consider brotli for better ratio');
  }

  if (httpVersion === 'HTTP/1.0' || httpVersion === 'HTTP/1.1') {
    issues.push('HTTP/1.1 only');
  }

  const hasCompression = !!contentEncoding && contentEncoding !== 'identity';
  const modernHttp = httpVersion === 'HTTP/2' || httpVersion === 'HTTP/3';
  const passed = hasCompression && modernHttp;

  return {
    url,
    httpVersion,
    contentEncoding,
    contentLength,
    transferLength,
    compressionRatio,
    supportsBrotli,
    altSvcHasH3,
    issues,
    passed,
  };
}
