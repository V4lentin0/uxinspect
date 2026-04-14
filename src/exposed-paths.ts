export interface ExposedPathsOptions {
  extraPaths?: string[];
  concurrency?: number;
  timeoutMs?: number;
}

export interface ExposedPathFinding {
  path: string;
  url: string;
  status: number;
  contentSnippet?: string;
  severity: 'high' | 'medium' | 'low';
}

export interface ExposedPathsResult {
  baseUrl: string;
  scanned: number;
  findings: ExposedPathFinding[];
  securityTxtPresent: boolean;
  passed: boolean;
}

interface PathEntry {
  path: string;
  severity: 'high' | 'medium' | 'low';
  marker?: RegExp;
}

const DEFAULT_PATHS: PathEntry[] = [
  { path: '/.git/config', severity: 'high', marker: /\[core\]/i },
  { path: '/.git/HEAD', severity: 'high', marker: /ref:\s*refs\// },
  { path: '/.env', severity: 'high', marker: /=/ },
  { path: '/.env.local', severity: 'high' },
  { path: '/.env.production', severity: 'high' },
  { path: '/.DS_Store', severity: 'medium' },
  { path: '/backup.sql', severity: 'high' },
  { path: '/backup.zip', severity: 'high' },
  { path: '/dump.sql', severity: 'high', marker: /-- MySQL dump/i },
  { path: '/wp-config.php.bak', severity: 'high' },
  { path: '/.htaccess', severity: 'medium' },
  { path: '/.htpasswd', severity: 'high' },
  { path: '/phpinfo.php', severity: 'medium' },
  { path: '/info.php', severity: 'medium' },
  { path: '/composer.json', severity: 'low' },
  { path: '/composer.lock', severity: 'low' },
  { path: '/package.json', severity: 'low' },
  { path: '/yarn.lock', severity: 'low' },
  { path: '/Dockerfile', severity: 'low' },
  { path: '/docker-compose.yml', severity: 'low' },
  { path: '/server-status', severity: 'medium' },
  { path: '/server-info', severity: 'medium' },
  { path: '/.svn/entries', severity: 'high' },
  { path: '/config.json', severity: 'medium' },
  { path: '/config.yml', severity: 'medium' },
  { path: '/credentials.json', severity: 'high' },
  { path: '/web.config', severity: 'low' },
  { path: '/crossdomain.xml', severity: 'low' },
  { path: '/clientaccesspolicy.xml', severity: 'low' },
  { path: '/admin/', severity: 'low' },
  { path: '/api/', severity: 'low' },
  { path: '/console', severity: 'low' },
  { path: '/debug', severity: 'medium' },
  { path: '/trace.axd', severity: 'medium' },
  { path: '/.vscode/settings.json', severity: 'low' },
  { path: '/.idea/workspace.xml', severity: 'low' },
];

async function checkPath(
  baseUrl: string,
  entry: PathEntry,
  timeoutMs: number,
): Promise<ExposedPathFinding | null> {
  const url = baseUrl + entry.path;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-200' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200 && res.status !== 206) return null;
    const ct = res.headers.get('content-type') ?? '';
    const body = await res.text();
    const snippet = body.slice(0, 120);
    const isHtml = ct.toLowerCase().startsWith('text/html');
    const markerMatch = entry.marker ? entry.marker.test(snippet) : false;
    if (!isHtml || markerMatch) {
      return {
        path: entry.path,
        url,
        status: res.status,
        contentSnippet: snippet || undefined,
        severity: entry.severity,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function runConcurrent<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;
  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

export async function scanExposedPaths(
  baseUrl: string,
  opts?: ExposedPathsOptions,
): Promise<ExposedPathsResult> {
  const concurrency = opts?.concurrency ?? 8;
  const timeoutMs = opts?.timeoutMs ?? 3000;
  const base = baseUrl.replace(/\/$/, '');

  const extraEntries: PathEntry[] = (opts?.extraPaths ?? []).map((p) => ({
    path: p.startsWith('/') ? p : `/${p}`,
    severity: 'low' as const,
  }));

  const allPaths = [...DEFAULT_PATHS, ...extraEntries];

  const tasks = allPaths.map((entry) => () => checkPath(base, entry, timeoutMs));
  const raw = await runConcurrent(tasks, concurrency);
  const findings = raw.filter((f): f is ExposedPathFinding => f !== null);

  let securityTxtPresent = false;
  try {
    const secRes = await fetch(`${base}/.well-known/security.txt`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (secRes.status === 200) {
      const body = await secRes.text();
      securityTxtPresent = body.includes('Contact:');
    }
  } catch {
    // not present
  }

  return {
    baseUrl: base,
    scanned: allPaths.length,
    findings,
    securityTxtPresent,
    passed: !findings.some((f) => f.severity === 'high'),
  };
}
