import tls from 'node:tls';
import https from 'node:https';

export interface TLSAuditOptions {
  timeoutMs?: number;
  port?: number;
}

export interface TLSAuditResult {
  host: string;
  port: number;
  protocol?: string;
  cipher?: { name: string; version: string; standardName?: string };
  cert?: {
    subject: string;
    issuer: string;
    validFrom: string;
    validTo: string;
    daysUntilExpiry: number;
    selfSigned: boolean;
    keyLength?: number;
  };
  chainComplete: boolean;
  hstsHeader?: string;
  hstsPreloadEligible: boolean;
  issues: { level: 'error' | 'warn' | 'info'; message: string }[];
  passed: boolean;
}

function buildDN(obj: Record<string, string> | undefined): string {
  if (!obj) return '';
  return ['CN', 'O', 'C'].flatMap(k => (obj[k] ? [`${k}=${obj[k]}`] : [])).join(', ');
}

function checkChain(cert: tls.DetailedPeerCertificate, selfSigned: boolean): boolean {
  if (selfSigned) return true;
  const visited = new Set<string>();
  let cur: tls.DetailedPeerCertificate | null = cert;
  let depth = 0;
  while (cur) {
    const fp = cur.fingerprint256 ?? cur.fingerprint;
    if (!fp || visited.has(fp)) break;
    visited.add(fp);
    depth++;
    const next = cur.issuerCertificate as tls.DetailedPeerCertificate | undefined;
    if (!next || next === cur) break;
    cur = next;
  }
  return depth >= 2;
}

async function fetchHsts(host: string, port: number, timeoutMs: number): Promise<string | undefined> {
  return new Promise(resolve => {
    const req = https.request(
      { host, port, path: '/', method: 'GET', rejectUnauthorized: false, timeout: timeoutMs },
      res => {
        resolve(res.headers['strict-transport-security'] as string | undefined);
        res.destroy();
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(undefined); });
    req.on('error', () => resolve(undefined));
    req.end();
  });
}

export async function auditTls(hostOrUrl: string, opts?: TLSAuditOptions): Promise<TLSAuditResult> {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const port = opts?.port ?? 443;

  let host: string;
  if (/^https?:\/\//i.test(hostOrUrl)) {
    host = new URL(hostOrUrl).hostname;
  } else {
    host = hostOrUrl;
  }

  const issues: TLSAuditResult['issues'] = [];
  let socket: tls.TLSSocket | null = null;

  const tlsResult = await new Promise<{
    protocol?: string;
    cipher?: { name: string; version: string; standardName?: string };
    cert?: tls.DetailedPeerCertificate;
  }>((resolve, reject) => {
    socket = tls.connect(
      { host, port, servername: host, rejectUnauthorized: false, ALPNProtocols: ['h2', 'http/1.1'], timeout: timeoutMs },
      () => {
        const s = socket!;
        resolve({
          protocol: s.getProtocol() ?? undefined,
          cipher: s.getCipher() as { name: string; version: string; standardName?: string } | undefined,
          cert: s.getPeerCertificate(true) as tls.DetailedPeerCertificate | undefined,
        });
      }
    );
    socket.on('timeout', () => reject(new Error('TLS connection timed out')));
    socket.on('error', reject);
  }).finally(() => {
    try { socket?.end(); } catch { /* ignore */ }
  });

  const { protocol, cipher, cert: rawCert } = tlsResult;

  if (protocol && !['TLSv1.2', 'TLSv1.3'].includes(protocol)) {
    issues.push({ level: 'error', message: `Weak TLS protocol: ${protocol}` });
  }

  if (cipher && /(CBC|RC4|3DES|MD5|NULL|EXPORT)/i.test(cipher.name)) {
    issues.push({ level: 'warn', message: `Weak cipher suite: ${cipher.name}` });
  }

  let certInfo: TLSAuditResult['cert'] | undefined;
  let chainComplete = false;

  if (rawCert && rawCert.subject) {
    const subject = buildDN(rawCert.subject as unknown as Record<string, string>);
    const issuer = buildDN(rawCert.issuer as unknown as Record<string, string>);
    const validFrom = rawCert.valid_from ?? '';
    const validTo = rawCert.valid_to ?? '';
    const daysUntilExpiry = Math.floor((new Date(validTo).getTime() - Date.now()) / 86_400_000);
    const selfSigned =
      rawCert.subject?.CN !== undefined && rawCert.subject.CN === rawCert.issuer?.CN;
    const keyLength = (rawCert as unknown as { bits?: number }).bits;

    chainComplete = checkChain(rawCert, selfSigned);

    certInfo = { subject, issuer, validFrom, validTo, daysUntilExpiry, selfSigned, keyLength };

    if (daysUntilExpiry < 7) {
      issues.push({ level: 'error', message: `Certificate expires in ${daysUntilExpiry} day(s)` });
    } else if (daysUntilExpiry < 30) {
      issues.push({ level: 'warn', message: `Certificate expires in ${daysUntilExpiry} day(s)` });
    }

    if (selfSigned && port === 443) {
      issues.push({ level: 'error', message: 'Self-signed certificate on port 443' });
    }

    if (keyLength !== undefined && keyLength < 2048) {
      issues.push({ level: 'warn', message: `Weak key length: ${keyLength} bits` });
    }
  }

  const hstsHeader = await fetchHsts(host, port, timeoutMs);

  let hstsPreloadEligible = false;
  if (hstsHeader) {
    const maxAgeMatch = /max-age=(\d+)/i.exec(hstsHeader);
    const maxAge = maxAgeMatch ? parseInt(maxAgeMatch[1], 10) : 0;
    const includeSubDomains = /includeSubDomains/i.test(hstsHeader);
    const preload = /\bpreload\b/i.test(hstsHeader);
    hstsPreloadEligible = maxAge >= 31_536_000 && includeSubDomains && preload;
  }

  const passed = issues.every(i => i.level !== 'error');

  return {
    host,
    port,
    protocol,
    cipher,
    cert: certInfo,
    chainComplete,
    hstsHeader,
    hstsPreloadEligible,
    issues,
    passed,
  };
}
