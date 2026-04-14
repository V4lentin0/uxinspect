export interface SecurityHeadersResult {
  page: string;
  headers: Record<string, string>;
  issues: string[];
  passed: boolean;
}

const REQUIRED_HEADERS: { name: string; check?: (v: string) => string | null }[] = [
  { name: 'content-security-policy' },
  { name: 'strict-transport-security', check: (v) => (/max-age=\d{6,}/.test(v) ? null : 'weak HSTS (max-age too short)') },
  { name: 'x-content-type-options', check: (v) => (v.toLowerCase().includes('nosniff') ? null : 'must be nosniff') },
  { name: 'x-frame-options' },
  { name: 'referrer-policy' },
  { name: 'permissions-policy' },
];

export async function checkSecurityHeaders(url: string): Promise<SecurityHeadersResult> {
  const res = await fetch(url, { redirect: 'follow' });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  const issues: string[] = [];
  for (const req of REQUIRED_HEADERS) {
    const v = headers[req.name];
    if (!v) {
      issues.push(`missing ${req.name}`);
      continue;
    }
    if (req.check) {
      const problem = req.check(v);
      if (problem) issues.push(`${req.name}: ${problem}`);
    }
  }
  if (headers['server']) issues.push(`server header leaks: ${headers['server']}`);
  if (headers['x-powered-by']) issues.push(`x-powered-by leaks: ${headers['x-powered-by']}`);

  return { page: url, headers, issues, passed: issues.length === 0 };
}
