import type { Page } from 'playwright';

export interface ThirdPartyCategoryCounts {
  analytics: number;
  ads: number;
  socialMedia: number;
  customerSupport: number;
  tagManager: number;
  cdn: number;
  other: number;
}

export interface ThirdPartyEntity {
  entity: string;
  category: string;
  resourceCount: number;
  bytes: number;
  blockingMs: number;
}

export interface ThirdPartyIssue {
  type: 'too-many-third-parties' | 'heavy-analytics' | 'unblockable-ad-script' | 'render-blocking-3p';
  detail: string;
}

export interface ThirdPartyResult {
  page: string;
  firstPartyOrigin: string;
  totalResources: number;
  thirdPartyResources: number;
  thirdPartyBytes: number;
  thirdPartyBlockingMs: number;
  categories: ThirdPartyCategoryCounts;
  topEntities: ThirdPartyEntity[];
  issues: ThirdPartyIssue[];
  passed: boolean;
}

interface RawResource {
  name: string;
  initiatorType: string;
  transferSize: number;
  duration: number;
  renderBlockingStatus: string;
  encodedBodySize: number;
}

interface EntityPattern {
  entity: string;
  category: keyof ThirdPartyCategoryCounts;
  match: (host: string, url: string) => boolean;
}

const ENTITY_TABLE: EntityPattern[] = [
  { entity: 'Google Tag Manager', category: 'tagManager', match: (h, u) => h.includes('googletagmanager.com') || u.includes('/gtag/') },
  { entity: 'Adobe DTM', category: 'tagManager', match: (h) => h.includes('adobedtm.com') },
  { entity: 'Tealium', category: 'tagManager', match: (h) => h.includes('tealium.com') },
  { entity: 'LaunchDarkly', category: 'tagManager', match: (h) => h.includes('launchdarkly.com') },

  { entity: 'Google Analytics', category: 'analytics', match: (h) => h.includes('google-analytics.com') },
  { entity: 'Segment', category: 'analytics', match: (h) => h.includes('segment.com') || h.includes('segment.io') },
  { entity: 'Mixpanel', category: 'analytics', match: (h) => h.includes('mixpanel.com') },
  { entity: 'Amplitude', category: 'analytics', match: (h) => h.includes('amplitude.com') },
  { entity: 'Heap', category: 'analytics', match: (h) => h.includes('heap.io') || h.endsWith('heapanalytics.com') },
  { entity: 'PostHog', category: 'analytics', match: (h) => h.includes('posthog.com') },
  { entity: 'Plausible', category: 'analytics', match: (h) => h.includes('plausible.io') },
  { entity: 'Matomo', category: 'analytics', match: (h) => h.includes('matomo') },
  { entity: 'StatCounter', category: 'analytics', match: (h) => h.includes('statcounter.com') },

  { entity: 'Google Ads / DoubleClick', category: 'ads', match: (h) => h.includes('doubleclick.net') || h.includes('googlesyndication.com') },
  { entity: 'Amazon Ads', category: 'ads', match: (h) => h.includes('adsystem.amazon') },
  { entity: 'Criteo', category: 'ads', match: (h) => h.includes('criteo.com') },
  { entity: 'Taboola', category: 'ads', match: (h) => h.includes('taboola.com') },
  { entity: 'Outbrain', category: 'ads', match: (h) => h.includes('outbrain.com') },
  { entity: 'PubMatic', category: 'ads', match: (h) => h.includes('pubmatic.com') },
  { entity: 'Rubicon', category: 'ads', match: (h) => h.includes('rubiconproject.com') },

  { entity: 'Facebook', category: 'socialMedia', match: (h) => h.includes('facebook.net') || h.includes('connect.facebook.net') },
  { entity: 'Twitter / X', category: 'socialMedia', match: (h, u) => h.includes('platform.twitter.com') || (h.includes('twitter.com') && u.includes('/widgets')) },
  { entity: 'LinkedIn', category: 'socialMedia', match: (h, u) => h.includes('linkedin.com') && u.includes('/li') },
  { entity: 'Pinterest', category: 'socialMedia', match: (h, u) => h.includes('pinterest.com') && u.includes('/js') },

  { entity: 'Intercom', category: 'customerSupport', match: (h) => h.includes('intercom.io') || h.includes('intercomcdn.com') },
  { entity: 'Zendesk', category: 'customerSupport', match: (h) => h.includes('zendesk.com') },
  { entity: 'Drift', category: 'customerSupport', match: (h) => h.includes('drift.com') },
  { entity: 'Crisp', category: 'customerSupport', match: (h) => h.includes('crisp.chat') },
  { entity: 'tawk.to', category: 'customerSupport', match: (h) => h.includes('tawk.to') },
  { entity: 'LiveChat', category: 'customerSupport', match: (h) => h.includes('livechatinc.com') },
  { entity: 'Help Scout', category: 'customerSupport', match: (h) => h.includes('helpscout.com') || h.includes('helpscout.net') },

  { entity: 'cdnjs (Cloudflare)', category: 'cdn', match: (h) => h.includes('cdnjs.cloudflare.com') },
  { entity: 'jsDelivr', category: 'cdn', match: (h) => h.includes('jsdelivr.net') },
  { entity: 'unpkg', category: 'cdn', match: (h) => h.includes('unpkg.com') },
];

function parseOrigin(url: string): { origin: string; host: string } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return { origin: u.origin, host: u.hostname.toLowerCase() };
  } catch {
    return null;
  }
}

function classify(host: string, url: string): { entity: string; category: keyof ThirdPartyCategoryCounts } {
  for (const p of ENTITY_TABLE) {
    if (p.match(host, url)) return { entity: p.entity, category: p.category };
  }
  return { entity: host, category: 'other' };
}

function isRenderBlocking(status: string): boolean {
  const s = (status || '').toLowerCase();
  return s === 'blocking' || s === 'render-blocking';
}

export async function auditThirdParty(page: Page): Promise<ThirdPartyResult> {
  const pageUrl = page.url();
  const parsedPage = parseOrigin(pageUrl);
  const firstPartyOrigin = parsedPage?.origin ?? '';

  const resources = await page.evaluate((): RawResource[] => {
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    return entries.map((e) => ({
      name: e.name,
      initiatorType: e.initiatorType,
      transferSize: typeof e.transferSize === 'number' ? e.transferSize : 0,
      duration: typeof e.duration === 'number' ? e.duration : 0,
      renderBlockingStatus: (e as unknown as { renderBlockingStatus?: string }).renderBlockingStatus || '',
      encodedBodySize: typeof e.encodedBodySize === 'number' ? e.encodedBodySize : 0,
    }));
  });

  const totalResources = resources.length;
  const categories: ThirdPartyCategoryCounts = {
    analytics: 0,
    ads: 0,
    socialMedia: 0,
    customerSupport: 0,
    tagManager: 0,
    cdn: 0,
    other: 0,
  };

  interface EntityAgg {
    entity: string;
    category: keyof ThirdPartyCategoryCounts;
    resourceCount: number;
    bytes: number;
    blockingMs: number;
  }
  const entityMap = new Map<string, EntityAgg>();

  let thirdPartyResources = 0;
  let thirdPartyBytes = 0;
  let thirdPartyBlockingMs = 0;
  let analyticsBytes = 0;
  const renderBlockingThirdParty: RawResource[] = [];
  const adResources: RawResource[] = [];

  for (const r of resources) {
    const parsed = parseOrigin(r.name);
    if (!parsed) continue;
    if (parsed.origin === firstPartyOrigin) continue;

    thirdPartyResources++;
    const size = r.transferSize > 0 ? r.transferSize : r.encodedBodySize;
    thirdPartyBytes += size;

    const { entity, category } = classify(parsed.host, r.name);
    categories[category]++;

    const blockingMs = isRenderBlocking(r.renderBlockingStatus) ? r.duration : 0;
    if (blockingMs > 0) {
      thirdPartyBlockingMs += blockingMs;
      renderBlockingThirdParty.push(r);
    }

    if (category === 'analytics') analyticsBytes += size;
    if (category === 'ads') adResources.push(r);

    const key = `${entity}::${category}`;
    const agg = entityMap.get(key);
    if (agg) {
      agg.resourceCount++;
      agg.bytes += size;
      agg.blockingMs += blockingMs;
    } else {
      entityMap.set(key, { entity, category, resourceCount: 1, bytes: size, blockingMs });
    }
  }

  const topEntities: ThirdPartyEntity[] = Array.from(entityMap.values())
    .sort((a, b) => b.bytes - a.bytes || b.resourceCount - a.resourceCount)
    .slice(0, 10)
    .map((e) => ({
      entity: e.entity,
      category: e.category,
      resourceCount: e.resourceCount,
      bytes: e.bytes,
      blockingMs: Math.round(e.blockingMs),
    }));

  const issues: ThirdPartyIssue[] = [];

  if (thirdPartyResources > 20) {
    issues.push({
      type: 'too-many-third-parties',
      detail: `${thirdPartyResources} third-party resources loaded (threshold: 20)`,
    });
  }

  if (analyticsBytes > 100 * 1024) {
    issues.push({
      type: 'heavy-analytics',
      detail: `analytics payload ${Math.round(analyticsBytes / 1024)}KB exceeds 100KB budget`,
    });
  }

  for (const r of renderBlockingThirdParty) {
    const parsed = parseOrigin(r.name);
    const host = parsed?.host ?? r.name;
    issues.push({
      type: 'render-blocking-3p',
      detail: `render-blocking third-party ${r.initiatorType || 'resource'} from ${host} (${Math.round(r.duration)}ms)`,
    });
  }

  for (const r of adResources) {
    if (isRenderBlocking(r.renderBlockingStatus) && (r.initiatorType === 'script' || /\.js(\?|$)/i.test(r.name))) {
      const parsed = parseOrigin(r.name);
      issues.push({
        type: 'unblockable-ad-script',
        detail: `ad script blocks render: ${parsed?.host ?? r.name}`,
      });
    }
  }

  return {
    page: pageUrl,
    firstPartyOrigin,
    totalResources,
    thirdPartyResources,
    thirdPartyBytes,
    thirdPartyBlockingMs: Math.round(thirdPartyBlockingMs),
    categories,
    topEntities,
    issues,
    passed: issues.length === 0,
  };
}
