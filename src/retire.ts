import type { Page } from 'playwright';

export interface RetireFinding {
  url: string;
  library: string;
  version: string;
  vulnerabilities: {
    severity: 'low' | 'medium' | 'high' | 'critical';
    summary: string;
    identifiers?: { CVE?: string[]; issue?: string };
    info?: string[];
  }[];
}

export interface RetireResult {
  findings: RetireFinding[];
  librariesScanned: number;
  passed: boolean;
}

interface Vuln {
  below: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  cve?: string[];
}

interface Signature {
  name: string;
  urlPattern: RegExp;
  versionPattern: RegExp;
  vulns: Vuln[];
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

const SIGNATURES: Signature[] = [
  {
    name: 'jquery',
    urlPattern: /jquery[-.]?(\d[\d.]*)(\.min)?\.js/i,
    versionPattern: /jquery[-.]?(\d[\d.]*)/i,
    vulns: [
      { below: '3.5.0', severity: 'medium', summary: 'XSS via HTML parsing', cve: ['CVE-2020-11022', 'CVE-2020-11023'] },
    ],
  },
  {
    name: 'jquery-migrate',
    urlPattern: /jquery-migrate[-.]?(\d[\d.]*)(\.min)?\.js/i,
    versionPattern: /jquery-migrate[-.]?(\d[\d.]*)/i,
    vulns: [
      { below: '1.4.1', severity: 'low', summary: 'XSS via cross-origin data' },
    ],
  },
  {
    name: 'angular',
    urlPattern: /angular[-.]?(\d[\d.]*)(\.min)?\.js/i,
    versionPattern: /angular[-.]?(\d[\d.]*)/i,
    vulns: [
      { below: '1.8.0', severity: 'high', summary: 'Prototype pollution via merge operations' },
    ],
  },
  {
    name: 'lodash',
    urlPattern: /lodash[-.]?(\d[\d.]*)(\.min)?\.js/i,
    versionPattern: /lodash[-.]?(\d[\d.]*)/i,
    vulns: [
      { below: '4.17.21', severity: 'high', summary: 'Prototype pollution via zipObjectDeep', cve: ['CVE-2020-8203'] },
    ],
  },
  {
    name: 'bootstrap',
    urlPattern: /bootstrap[-.]?(\d[\d.]*)(\.min)?\.js/i,
    versionPattern: /bootstrap[-.]?(\d[\d.]*)/i,
    vulns: [
      { below: '4.3.1', severity: 'medium', summary: 'XSS via data-template attribute', cve: ['CVE-2019-8331'] },
    ],
  },
  {
    name: 'moment',
    urlPattern: /moment[-.]?(\d[\d.]*)(\.min)?\.js/i,
    versionPattern: /moment[-.]?(\d[\d.]*)/i,
    vulns: [
      { below: '2.29.4', severity: 'medium', summary: 'ReDoS via crafted date string', cve: ['CVE-2022-31129'] },
    ],
  },
  {
    name: 'underscore',
    urlPattern: /underscore[-.]?(\d[\d.]*)(\.min)?\.js/i,
    versionPattern: /underscore[-.]?(\d[\d.]*)/i,
    vulns: [
      { below: '1.13.0', severity: 'high', summary: 'Arbitrary code execution via template injection', cve: ['CVE-2021-23358'] },
    ],
  },
  {
    name: 'handlebars',
    urlPattern: /handlebars[-.]?(\d[\d.]*)(\.min)?\.js/i,
    versionPattern: /handlebars[-.]?(\d[\d.]*)/i,
    vulns: [
      { below: '4.7.7', severity: 'high', summary: 'Prototype pollution and RCE via template compilation', cve: ['CVE-2021-23369'] },
    ],
  },
  {
    name: 'marked',
    urlPattern: /marked[-.]?(\d[\d.]*)(\.min)?\.js/i,
    versionPattern: /marked[-.]?(\d[\d.]*)/i,
    vulns: [
      { below: '4.0.10', severity: 'medium', summary: 'ReDoS via malformed markdown', cve: ['CVE-2022-21680'] },
    ],
  },
  {
    name: 'axios',
    urlPattern: /axios[-.]?(\d[\d.]*)(\.min)?\.js/i,
    versionPattern: /axios[-.]?(\d[\d.]*)/i,
    vulns: [
      { below: '0.21.2', severity: 'high', summary: 'ReDoS via overly long HTTP method', cve: ['CVE-2021-3749'] },
    ],
  },
  {
    name: 'dompurify',
    urlPattern: /dompurify[-.]?(\d[\d.]*)(\.min)?\.js/i,
    versionPattern: /dompurify[-.]?(\d[\d.]*)/i,
    vulns: [
      { below: '2.3.3', severity: 'medium', summary: 'XSS bypass via mXSS mutation' },
    ],
  },
  {
    name: 'prototypejs',
    urlPattern: /prototype[-.]?(\d[\d.]*)(\.min)?\.js/i,
    versionPattern: /prototype[-.]?(\d[\d.]*)/i,
    vulns: [
      { below: '1.7.3', severity: 'medium', summary: 'Prototype pollution via Object.extend', cve: ['CVE-2020-27511'] },
    ],
  },
];

export async function checkRetireJs(page: Page): Promise<RetireResult> {
  const scriptUrls: string[] = await page.$$eval(
    'script[src]',
    els => els.map(s => (s as HTMLScriptElement).src)
  );

  const findings: RetireFinding[] = [];
  let librariesScanned = 0;

  for (const url of scriptUrls) {
    for (const sig of SIGNATURES) {
      const urlMatch = sig.urlPattern.exec(url);
      if (!urlMatch) continue;

      const versionMatch = sig.versionPattern.exec(url);
      if (!versionMatch) continue;

      const version = versionMatch[1];
      librariesScanned++;

      const triggeredVulns = sig.vulns
        .filter(v => cmpVersion(version, v.below) < 0)
        .map(v => ({
          severity: v.severity,
          summary: v.summary,
          ...(v.cve ? { identifiers: { CVE: v.cve } } : {}),
        }));

      if (triggeredVulns.length > 0) {
        findings.push({ url, library: sig.name, version, vulnerabilities: triggeredVulns });
      }
    }
  }

  const passed = !findings.some(f =>
    f.vulnerabilities.some(v => v.severity === 'medium' || v.severity === 'high' || v.severity === 'critical')
  );

  return { findings, librariesScanned, passed };
}
