import type { Page } from 'playwright';

export type InsecureResourceType = 'script' | 'style' | 'image' | 'iframe' | 'font' | 'xhr' | 'other';

export interface InsecureResource {
  type: InsecureResourceType;
  url: string;
  initiator?: string;
}

export interface MixedContentResult {
  page: string;
  httpsPage: boolean;
  insecureResources: InsecureResource[];
  cspPresent: boolean;
  cspUpgradeInsecure: boolean;
  cspBlockAllMixed: boolean;
  referrerPolicy?: string;
  passed: boolean;
}

interface MixedContentSnapshot {
  pageProtocol: string;
  entries: Array<{ name: string; initiatorType: string }>;
  cspMeta: string | null;
  referrerMeta: string | null;
  referrerPolicy: string;
}

function classifyInitiator(initiatorType: string): InsecureResourceType {
  switch (initiatorType) {
    case 'script':
      return 'script';
    case 'css':
    case 'link':
      return 'style';
    case 'img':
    case 'image':
      return 'image';
    case 'iframe':
    case 'subdocument':
      return 'iframe';
    case 'font':
      return 'font';
    case 'xmlhttprequest':
    case 'fetch':
      return 'xhr';
    default:
      return 'other';
  }
}

function parseCspDirectives(csp: string): Set<string> {
  const directives = new Set<string>();
  for (const raw of csp.split(';')) {
    const name = raw.trim().split(/\s+/)[0]?.toLowerCase();
    if (name) directives.add(name);
  }
  return directives;
}

export async function checkMixedContent(page: Page): Promise<MixedContentResult> {
  const pageUrl = page.url();
  let pageProtocol = 'about:';
  try {
    pageProtocol = new URL(pageUrl).protocol;
  } catch {}
  const httpsPage = pageProtocol === 'https:';

  const snapshot = await page.evaluate((): MixedContentSnapshot => {
    const entries = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map((e) => ({
      name: e.name,
      initiatorType: e.initiatorType,
    }));
    const cspEl = document.querySelector('meta[http-equiv="Content-Security-Policy" i]') as HTMLMetaElement | null;
    const refEl = document.querySelector('meta[name="referrer" i]') as HTMLMetaElement | null;
    return {
      pageProtocol: location.protocol,
      entries,
      cspMeta: cspEl?.content ?? null,
      referrerMeta: refEl?.content ?? null,
      referrerPolicy: (document as unknown as { referrerPolicy?: string }).referrerPolicy ?? '',
    };
  });

  const insecureResources: InsecureResource[] = [];
  for (const entry of snapshot.entries) {
    if (entry.name.toLowerCase().startsWith('http://')) {
      insecureResources.push({
        type: classifyInitiator(entry.initiatorType),
        url: entry.name,
        initiator: entry.initiatorType || undefined,
      });
    }
  }

  const cspPresent = typeof snapshot.cspMeta === 'string' && snapshot.cspMeta.length > 0;
  let cspUpgradeInsecure = false;
  let cspBlockAllMixed = false;
  if (cspPresent && snapshot.cspMeta) {
    const directives = parseCspDirectives(snapshot.cspMeta);
    cspUpgradeInsecure = directives.has('upgrade-insecure-requests');
    cspBlockAllMixed = directives.has('block-all-mixed-content');
  }

  const referrerPolicy = snapshot.referrerMeta?.trim() || snapshot.referrerPolicy?.trim() || undefined;

  const passed = !httpsPage || insecureResources.length === 0;

  return {
    page: pageUrl,
    httpsPage,
    insecureResources,
    cspPresent,
    cspUpgradeInsecure,
    cspBlockAllMixed,
    referrerPolicy,
    passed,
  };
}
