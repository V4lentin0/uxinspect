import type { Page } from 'playwright';

export interface ProtocolAuditResult {
  page: string;
  protocols: { protocol: string; count: number }[];
  http1Count: number;
  http2Count: number;
  http3Count: number;
  nonEncryptedCount: number;
  earlyHints: boolean;
  alpn?: string;
  passed: boolean;
}

interface CDPResponseReceivedParams {
  response?: {
    url?: string;
    protocol?: string;
    status?: number;
  };
}

interface CDPEarlyHintsParams {
  response?: {
    url?: string;
  };
  headers?: Record<string, string>;
}

interface MinimalCDPSession {
  send(method: string): Promise<unknown>;
  on(event: string, handler: (params: unknown) => void): void;
  off(event: string, handler: (params: unknown) => void): void;
  detach(): Promise<void>;
}

interface CDPCapableContext {
  newCDPSession(page: Page): Promise<MinimalCDPSession>;
}

function classifyProtocol(protocol: string): 'h1' | 'h2' | 'h3' | 'other' {
  const p = protocol.toLowerCase();
  if (p.startsWith('http/1')) return 'h1';
  if (p === 'h2' || p === 'h2c') return 'h2';
  if (p.startsWith('h3')) return 'h3';
  return 'other';
}

function emptyResult(pageUrl: string): ProtocolAuditResult {
  return {
    page: pageUrl,
    protocols: [],
    http1Count: 0,
    http2Count: 0,
    http3Count: 0,
    nonEncryptedCount: 0,
    earlyHints: false,
    passed: true,
  };
}

export async function auditProtocols(page: Page): Promise<ProtocolAuditResult> {
  const pageUrl = page.url();
  const context = page.context() as unknown as CDPCapableContext;

  let cdp: MinimalCDPSession | undefined;
  try {
    cdp = await context.newCDPSession(page);
  } catch {
    return emptyResult(pageUrl);
  }

  const counts = new Map<string, number>();
  let http1Count = 0;
  let http2Count = 0;
  let http3Count = 0;
  let nonEncryptedCount = 0;
  let earlyHints = false;
  let alpn: string | undefined;

  const onResponseReceived = (params: unknown): void => {
    const p = params as CDPResponseReceivedParams;
    const response = p.response;
    if (!response) return;
    const url = typeof response.url === 'string' ? response.url : '';
    const protocol = typeof response.protocol === 'string' ? response.protocol : '';
    const status = typeof response.status === 'number' ? response.status : 0;

    if (url.toLowerCase().startsWith('http://')) {
      nonEncryptedCount += 1;
    }

    if (status === 103) {
      earlyHints = true;
    }

    if (protocol) {
      counts.set(protocol, (counts.get(protocol) ?? 0) + 1);
      const bucket = classifyProtocol(protocol);
      if (bucket === 'h1') {
        http1Count += 1;
      } else if (bucket === 'h2') {
        http2Count += 1;
        if (!alpn) alpn = protocol;
      } else if (bucket === 'h3') {
        http3Count += 1;
        if (!alpn) alpn = protocol;
      }
    }
  };

  const onEarlyHints = (_params: unknown): void => {
    earlyHints = true;
  };

  try {
    await cdp.send('Network.enable');
  } catch {
    try {
      await cdp.detach();
    } catch {
      /* ignore */
    }
    return emptyResult(pageUrl);
  }

  cdp.on('Network.responseReceived', onResponseReceived);
  cdp.on('Network.responseReceivedEarlyHints', onEarlyHints);

  try {
    await page.reload({ waitUntil: 'networkidle' });
  } catch {
    /* reload failures still allow us to return partial data collected so far */
  }

  try {
    cdp.off('Network.responseReceived', onResponseReceived);
    cdp.off('Network.responseReceivedEarlyHints', onEarlyHints);
  } catch {
    /* ignore */
  }

  try {
    await cdp.detach();
  } catch {
    /* ignore */
  }

  const protocols = Array.from(counts.entries())
    .map(([protocol, count]) => ({ protocol, count }))
    .sort((a, b) => b.count - a.count);

  const totalRequests = http1Count + http2Count + http3Count;
  const modernPresent = http2Count + http3Count > 0;
  const passed =
    nonEncryptedCount === 0 && (totalRequests === 0 || http1Count === 0 || modernPresent);

  const result: ProtocolAuditResult = {
    page: pageUrl,
    protocols,
    http1Count,
    http2Count,
    http3Count,
    nonEncryptedCount,
    earlyHints,
    passed,
  };
  if (alpn !== undefined) result.alpn = alpn;
  return result;
}
