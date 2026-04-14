import type { Page, Request, Response, Cookie } from 'playwright';

export type TrackerCategory =
  | 'analytics'
  | 'advertising'
  | 'tag-manager'
  | 'session-replay'
  | 'consent'
  | 'fingerprint'
  | 'chat-widget'
  | 'a-b-testing'
  | 'heatmap'
  | 'other';

export interface TrackerEntry {
  name: string;
  category: TrackerCategory;
  domains: string[];
  requestCount: number;
  bytesTransferred: number;
  scriptSourceUrls: string[];
  detectedVia: 'request-pattern' | 'global-variable' | 'cookie-name';
}

export interface TrackerSniffResult {
  page: string;
  trackers: TrackerEntry[];
  stats: {
    total: number;
    byCategory: Record<TrackerCategory, number>;
    totalBytes: number;
    totalRequests: number;
  };
  consentRespected: boolean;
  passed: boolean;
}

interface PatternRule {
  name: string;
  category: TrackerCategory;
  hostPatterns: string[];
  pathPatterns?: string[];
}

interface GlobalRule {
  name: string;
  category: TrackerCategory;
  globals: string[];
}

interface CookieRule {
  name: string;
  category: TrackerCategory;
  cookiePatterns: RegExp[];
}

const PATTERN_RULES: PatternRule[] = [
  { name: 'ga', category: 'analytics', hostPatterns: ['google-analytics.com', 'analytics.google.com', 'ssl.google-analytics.com'] },
  { name: 'gtm', category: 'tag-manager', hostPatterns: ['googletagmanager.com'] },
  { name: 'mixpanel', category: 'analytics', hostPatterns: ['mixpanel.com', 'api.mixpanel.com', 'cdn.mxpnl.com'] },
  { name: 'amplitude', category: 'analytics', hostPatterns: ['amplitude.com', 'api.amplitude.com', 'api2.amplitude.com', 'cdn.amplitude.com'] },
  { name: 'segment', category: 'analytics', hostPatterns: ['segment.io', 'segment.com', 'cdn.segment.io', 'api.segment.io'] },
  { name: 'plausible', category: 'analytics', hostPatterns: ['plausible.io'] },
  { name: 'fathom', category: 'analytics', hostPatterns: ['usefathom.com', 'cdn.usefathom.com'] },
  { name: 'cloudflare-insights', category: 'analytics', hostPatterns: ['cloudflareinsights.com', 'static.cloudflareinsights.com'] },
  { name: 'simple-analytics', category: 'analytics', hostPatterns: ['simpleanalytics.com', 'scripts.simpleanalyticscdn.com', 'queue.simpleanalyticscdn.com'] },
  { name: 'umami', category: 'analytics', hostPatterns: ['umami.is', 'cloud.umami.is'] },
  { name: 'matomo', category: 'analytics', hostPatterns: ['matomo.cloud', 'matomo.org'], pathPatterns: ['/matomo.js', '/piwik.js'] },
  { name: 'heap', category: 'analytics', hostPatterns: ['heap.io', 'heapanalytics.com'] },
  { name: 'posthog', category: 'analytics', hostPatterns: ['posthog.com', 'app.posthog.com', 'eu.posthog.com'] },
  { name: 'statcounter', category: 'analytics', hostPatterns: ['statcounter.com'] },
  { name: 'pendo', category: 'analytics', hostPatterns: ['pendo.io', 'cdn.pendo.io'] },
  { name: 'meta-pixel', category: 'advertising', hostPatterns: ['facebook.net', 'connect.facebook.net'], pathPatterns: ['/fbevents.js', '/fbds.js', '/tr'] },
  { name: 'ad-network-doubleclick', category: 'advertising', hostPatterns: ['doubleclick.net'] },
  { name: 'ad-network-googleads', category: 'advertising', hostPatterns: ['googleadservices.com', 'googlesyndication.com'] },
  { name: 'ad-pagead', category: 'advertising', hostPatterns: ['google.com'], pathPatterns: ['/pagead', '/ads/'] },
  { name: 'criteo', category: 'advertising', hostPatterns: ['criteo.com', 'criteo.net', 'static.criteo.net'] },
  { name: 'taboola', category: 'advertising', hostPatterns: ['taboola.com', 'cdn.taboola.com', 'trc.taboola.com'] },
  { name: 'outbrain', category: 'advertising', hostPatterns: ['outbrain.com', 'outbrainimg.com'] },
  { name: 'pubmatic', category: 'advertising', hostPatterns: ['pubmatic.com'] },
  { name: 'rubicon', category: 'advertising', hostPatterns: ['rubiconproject.com'] },
  { name: 'amazon-ads', category: 'advertising', hostPatterns: ['amazon-adsystem.com'] },
  { name: 'linkedin-insight', category: 'advertising', hostPatterns: ['ads.linkedin.com', 'snap.licdn.com', 'px.ads.linkedin.com'] },
  { name: 'twitter-ads', category: 'advertising', hostPatterns: ['ads-twitter.com', 'analytics.twitter.com', 't.co'], pathPatterns: ['/i/adsct'] },
  { name: 'bing-ads', category: 'advertising', hostPatterns: ['bat.bing.com'] },
  { name: 'reddit-ads', category: 'advertising', hostPatterns: ['redditstatic.com'], pathPatterns: ['/ads/'] },
  { name: 'snapchat-ads', category: 'advertising', hostPatterns: ['sc-static.net'], pathPatterns: ['/scevent.min.js'] },
  { name: 'tiktok-pixel', category: 'advertising', hostPatterns: ['analytics.tiktok.com'] },
  { name: 'pinterest-ads', category: 'advertising', hostPatterns: ['ct.pinterest.com', 's.pinimg.com'] },
  { name: 'tealium', category: 'tag-manager', hostPatterns: ['tealiumiq.com', 'tealium.com'] },
  { name: 'ensighten', category: 'tag-manager', hostPatterns: ['ensighten.com', 'nexus.ensighten.com'] },
  { name: 'adobe-dtm', category: 'tag-manager', hostPatterns: ['adobedtm.com'] },
  { name: 'hotjar', category: 'session-replay', hostPatterns: ['hotjar.com', 'static.hotjar.com', 'script.hotjar.com', 'insights.hotjar.com'] },
  { name: 'fullstory', category: 'session-replay', hostPatterns: ['fullstory.com', 'rs.fullstory.com', 'edge.fullstory.com'] },
  { name: 'logrocket', category: 'session-replay', hostPatterns: ['logrocket.com', 'cdn.logrocket.io', 'r.logrocket.io', 'logrocket.io'] },
  { name: 'mouseflow', category: 'session-replay', hostPatterns: ['mouseflow.com', 'cdn.mouseflow.com', 'n1.mouseflow.com'] },
  { name: 'smartlook', category: 'session-replay', hostPatterns: ['smartlook.com', 'rec.smartlook.com'] },
  { name: 'clarity', category: 'session-replay', hostPatterns: ['clarity.ms', 'c.clarity.ms'] },
  { name: 'inspectlet', category: 'session-replay', hostPatterns: ['inspectlet.com'] },
  { name: 'consent-cookiebot', category: 'consent', hostPatterns: ['cookiebot.com', 'consent.cookiebot.com'] },
  { name: 'consent-onetrust', category: 'consent', hostPatterns: ['onetrust.com', 'cdn.cookielaw.org', 'geolocation.onetrust.com'] },
  { name: 'consent-quantcast', category: 'consent', hostPatterns: ['quantcast.com'], pathPatterns: ['/cmp'] },
  { name: 'consent-osano', category: 'consent', hostPatterns: ['osano.com', 'cmp.osano.com'] },
  { name: 'consent-iubenda', category: 'consent', hostPatterns: ['iubenda.com', 'cdn.iubenda.com'] },
  { name: 'consent-trustarc', category: 'consent', hostPatterns: ['trustarc.com', 'consent.trustarc.com'] },
  { name: 'consent-usercentrics', category: 'consent', hostPatterns: ['usercentrics.eu', 'app.usercentrics.eu'] },
  { name: 'consent-didomi', category: 'consent', hostPatterns: ['didomi.io', 'sdk.privacy-center.org'] },
  { name: 'fingerprint', category: 'fingerprint', hostPatterns: ['fingerprintjs.com', 'api.fpjs.io', 'fpjscdn.net', 'metrics.fpjs.io'] },
  { name: 'chat-intercom', category: 'chat-widget', hostPatterns: ['intercom.io', 'intercomcdn.com', 'widget.intercom.io'] },
  { name: 'chat-drift', category: 'chat-widget', hostPatterns: ['drift.com', 'js.driftt.com'] },
  { name: 'chat-zendesk', category: 'chat-widget', hostPatterns: ['zendesk.com', 'zdassets.com'], pathPatterns: ['/widgets', '/embeddable_framework'] },
  { name: 'chat-tawk', category: 'chat-widget', hostPatterns: ['tawk.to', 'embed.tawk.to'] },
  { name: 'chat-livechat', category: 'chat-widget', hostPatterns: ['livechatinc.com', 'cdn.livechatinc.com'] },
  { name: 'chat-crisp', category: 'chat-widget', hostPatterns: ['crisp.chat', 'client.crisp.chat'] },
  { name: 'chat-helpscout', category: 'chat-widget', hostPatterns: ['helpscout.com', 'helpscout.net', 'beacon-v2.helpscout.net'] },
  { name: 'chat-freshchat', category: 'chat-widget', hostPatterns: ['freshchat.com', 'wchat.freshchat.com'] },
  { name: 'optimizely', category: 'a-b-testing', hostPatterns: ['optimizely.com', 'cdn.optimizely.com'] },
  { name: 'launchdarkly', category: 'a-b-testing', hostPatterns: ['launchdarkly.com', 'app.launchdarkly.com', 'clientsdk.launchdarkly.com', 'events.launchdarkly.com'] },
  { name: 'split-io', category: 'a-b-testing', hostPatterns: ['split.io', 'sdk.split.io', 'events.split.io'] },
  { name: 'vwo', category: 'a-b-testing', hostPatterns: ['visualwebsiteoptimizer.com', 'dev.visualwebsiteoptimizer.com'] },
  { name: 'ab-tasty', category: 'a-b-testing', hostPatterns: ['abtasty.com', 'try.abtasty.com'] },
  { name: 'crazyegg', category: 'heatmap', hostPatterns: ['crazyegg.com', 'script.crazyegg.com'] },
  { name: 'lucky-orange', category: 'heatmap', hostPatterns: ['luckyorange.com', 'luckyorange.net'] },
];

const GLOBAL_RULES: GlobalRule[] = [
  { name: 'gtm', category: 'tag-manager', globals: ['dataLayer', 'google_tag_manager'] },
  { name: 'ga', category: 'analytics', globals: ['gtag', 'ga', 'GoogleAnalyticsObject'] },
  { name: 'meta-pixel', category: 'advertising', globals: ['fbq', '_fbq'] },
  { name: 'matomo', category: 'analytics', globals: ['_paq', 'Matomo'] },
  { name: 'mixpanel', category: 'analytics', globals: ['mixpanel'] },
  { name: 'amplitude', category: 'analytics', globals: ['amplitude'] },
  { name: 'segment', category: 'analytics', globals: ['analytics'] },
  { name: 'heap', category: 'analytics', globals: ['heap'] },
  { name: 'posthog', category: 'analytics', globals: ['posthog'] },
  { name: 'pendo', category: 'analytics', globals: ['pendo'] },
  { name: 'plausible', category: 'analytics', globals: ['plausible'] },
  { name: 'fathom', category: 'analytics', globals: ['fathom'] },
  { name: 'chat-intercom', category: 'chat-widget', globals: ['Intercom'] },
  { name: 'chat-drift', category: 'chat-widget', globals: ['drift'] },
  { name: 'chat-zendesk', category: 'chat-widget', globals: ['zE', 'zESettings'] },
  { name: 'chat-tawk', category: 'chat-widget', globals: ['Tawk_API'] },
  { name: 'chat-livechat', category: 'chat-widget', globals: ['LiveChatWidget', 'LC_API'] },
  { name: 'chat-crisp', category: 'chat-widget', globals: ['$crisp', 'CRISP_WEBSITE_ID'] },
  { name: 'hotjar', category: 'session-replay', globals: ['hj', '_hjSettings'] },
  { name: 'fullstory', category: 'session-replay', globals: ['FS', '_fs_host'] },
  { name: 'logrocket', category: 'session-replay', globals: ['LogRocket', '_LRLogger'] },
  { name: 'clarity', category: 'session-replay', globals: ['clarity'] },
  { name: 'smartlook', category: 'session-replay', globals: ['smartlook'] },
  { name: 'mouseflow', category: 'session-replay', globals: ['_mfq'] },
  { name: 'optimizely', category: 'a-b-testing', globals: ['optimizely'] },
  { name: 'launchdarkly', category: 'a-b-testing', globals: ['LDClient'] },
  { name: 'split-io', category: 'a-b-testing', globals: ['splitio'] },
  { name: 'vwo', category: 'a-b-testing', globals: ['_vwo_code', 'VWO'] },
  { name: 'fingerprint', category: 'fingerprint', globals: ['FingerprintJS', 'Fingerprint2'] },
  { name: 'consent-cookiebot', category: 'consent', globals: ['Cookiebot'] },
  { name: 'consent-onetrust', category: 'consent', globals: ['OneTrust', 'OnetrustActiveGroups'] },
  { name: 'consent-osano', category: 'consent', globals: ['Osano'] },
  { name: 'consent-iubenda', category: 'consent', globals: ['_iub'] },
  { name: 'consent-usercentrics', category: 'consent', globals: ['UC_UI', 'usercentrics'] },
];

const COOKIE_RULES: CookieRule[] = [
  { name: 'ga', category: 'analytics', cookiePatterns: [/^_ga(_|$)/, /^_gid$/, /^_gat/] },
  { name: 'meta-pixel', category: 'advertising', cookiePatterns: [/^_fbp$/, /^_fbc$/] },
  { name: 'mixpanel', category: 'analytics', cookiePatterns: [/^mp_/] },
  { name: 'amplitude', category: 'analytics', cookiePatterns: [/^amplitude_/, /^amp_/] },
  { name: 'hotjar', category: 'session-replay', cookiePatterns: [/^_hjid$/, /^_hjSession/, /^_hjIncludedIn/] },
  { name: 'chat-intercom', category: 'chat-widget', cookiePatterns: [/^intercom-/] },
  { name: 'segment', category: 'analytics', cookiePatterns: [/^ajs_/] },
  { name: 'bing-ads', category: 'advertising', cookiePatterns: [/^_uetsid$/, /^_uetvid$/, /^MUID$/] },
  { name: 'ad-network-doubleclick', category: 'advertising', cookiePatterns: [/^IDE$/, /^test_cookie$/] },
  { name: 'matomo', category: 'analytics', cookiePatterns: [/^_pk_/] },
  { name: 'heap', category: 'analytics', cookiePatterns: [/^_hp2_/] },
  { name: 'clarity', category: 'session-replay', cookiePatterns: [/^_clck$/, /^_clsk$/] },
  { name: 'optimizely', category: 'a-b-testing', cookiePatterns: [/^optimizelyEndUserId$/] },
  { name: 'crazyegg', category: 'heatmap', cookiePatterns: [/^_ceg\./] },
];

const CONSENT_COOKIE_NAME_RX = /(consent|gdpr|cookie_consent|cookiepolicy|cookielaw|cc_cookie|euconsent|cookiepref)/i;
const CONSENT_ACCEPTED_VALUE_RX = /(true|accepted|yes|granted|allow|opt[_-]?in|1\b)/i;

interface RequestRecord {
  url: string;
  host: string;
  timestamp: number;
  bytes: number;
  resourceType: string;
  initiatorScriptUrl?: string;
}

function parseHost(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function matchPattern(host: string, url: string, rule: PatternRule): boolean {
  const hostHit = rule.hostPatterns.some((h) => host === h || host.endsWith(`.${h}`) || host.includes(h));
  if (!hostHit) return false;
  if (!rule.pathPatterns || rule.pathPatterns.length === 0) return true;
  return rule.pathPatterns.some((p) => url.includes(p));
}

function classifyUrl(url: string): { name: string; category: TrackerCategory } | null {
  const host = parseHost(url);
  if (!host) return null;
  for (const rule of PATTERN_RULES) {
    if (matchPattern(host, url, rule)) {
      return { name: rule.name, category: rule.category };
    }
  }
  return null;
}

async function detectContentLength(request: Request): Promise<number> {
  let response: Response | null = null;
  try {
    response = await request.response();
  } catch {
    return 0;
  }
  if (!response) return 0;
  try {
    const headers = await response.allHeaders();
    const lenHeader = headers['content-length'];
    if (typeof lenHeader === 'string') {
      const parsed = parseInt(lenHeader, 10);
      if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
    }
  } catch {
    return 0;
  }
  return 0;
}

interface AggregateEntry {
  name: string;
  category: TrackerCategory;
  domains: Set<string>;
  requestCount: number;
  bytesTransferred: number;
  scriptSourceUrls: Set<string>;
  detectedVia: 'request-pattern' | 'global-variable' | 'cookie-name';
  firstRequestTime: number;
}

function getOrCreateEntry(
  map: Map<string, AggregateEntry>,
  name: string,
  category: TrackerCategory,
  detectedVia: 'request-pattern' | 'global-variable' | 'cookie-name',
): AggregateEntry {
  const existing = map.get(name);
  if (existing) return existing;
  const created: AggregateEntry = {
    name,
    category,
    domains: new Set<string>(),
    requestCount: 0,
    bytesTransferred: 0,
    scriptSourceUrls: new Set<string>(),
    detectedVia,
    firstRequestTime: Number.POSITIVE_INFINITY,
  };
  map.set(name, created);
  return created;
}

function findConsentTimestamp(cookies: Cookie[]): number | null {
  let earliest: number | null = null;
  for (const cookie of cookies) {
    if (!CONSENT_COOKIE_NAME_RX.test(cookie.name)) continue;
    if (!CONSENT_ACCEPTED_VALUE_RX.test(cookie.value)) continue;
    const expires = typeof cookie.expires === 'number' && cookie.expires > 0 ? cookie.expires * 1000 : Date.now();
    if (earliest === null || expires < earliest) earliest = expires;
  }
  return earliest;
}

async function detectGlobals(page: Page): Promise<Array<{ name: string; category: TrackerCategory }>> {
  try {
    return await page.evaluate((rules: GlobalRule[]): Array<{ name: string; category: TrackerCategory }> => {
      const hits: Array<{ name: string; category: TrackerCategory }> = [];
      const win = window as unknown as Record<string, unknown>;
      for (const rule of rules) {
        for (const key of rule.globals) {
          if (typeof win[key] !== 'undefined' && win[key] !== null) {
            hits.push({ name: rule.name, category: rule.category });
            break;
          }
        }
      }
      return hits;
    }, GLOBAL_RULES);
  } catch {
    return [];
  }
}

function toRecord(byCategory: Map<TrackerCategory, number>): Record<TrackerCategory, number> {
  const base: Record<TrackerCategory, number> = {
    'analytics': 0,
    'advertising': 0,
    'tag-manager': 0,
    'session-replay': 0,
    'consent': 0,
    'fingerprint': 0,
    'chat-widget': 0,
    'a-b-testing': 0,
    'heatmap': 0,
    'other': 0,
  };
  for (const [cat, count] of byCategory) base[cat] = count;
  return base;
}

export async function sniffTrackers(page: Page): Promise<TrackerSniffResult> {
  const pageUrl = page.url();
  const records: RequestRecord[] = [];
  const pendingSizePromises: Array<Promise<void>> = [];

  const onRequestFinished = (request: Request): void => {
    const url = request.url();
    const host = parseHost(url);
    if (!host) return;
    const sizePromise = detectContentLength(request).then((bytes) => {
      const record: RequestRecord = {
        url,
        host,
        timestamp: Date.now(),
        bytes,
        resourceType: request.resourceType(),
        initiatorScriptUrl: url,
      };
      records.push(record);
    }).catch(() => {
      /* swallow */
    });
    pendingSizePromises.push(sizePromise);
  };

  page.on('requestfinished', onRequestFinished);

  try {
    await page.waitForLoadState('networkidle', { timeout: 5000 });
  } catch {
    /* ignore timeouts; still capture what we have */
  }

  page.off('requestfinished', onRequestFinished);
  await Promise.all(pendingSizePromises).catch(() => {
    /* ignore */
  });

  const aggregates = new Map<string, AggregateEntry>();

  for (const rec of records) {
    const hit = classifyUrl(rec.url);
    if (!hit) continue;
    const entry = getOrCreateEntry(aggregates, hit.name, hit.category, 'request-pattern');
    entry.domains.add(rec.host);
    entry.requestCount += 1;
    entry.bytesTransferred += rec.bytes;
    if (rec.resourceType === 'script' && rec.initiatorScriptUrl) {
      entry.scriptSourceUrls.add(rec.initiatorScriptUrl);
    }
    if (rec.timestamp < entry.firstRequestTime) entry.firstRequestTime = rec.timestamp;
  }

  const globalHits = await detectGlobals(page);
  for (const hit of globalHits) {
    if (!aggregates.has(hit.name)) {
      getOrCreateEntry(aggregates, hit.name, hit.category, 'global-variable');
    }
  }

  const cookies = await page.context().cookies();
  for (const rule of COOKIE_RULES) {
    const matchedCookies = cookies.filter((c) => rule.cookiePatterns.some((rx) => rx.test(c.name)));
    if (matchedCookies.length === 0) continue;
    if (!aggregates.has(rule.name)) {
      const entry = getOrCreateEntry(aggregates, rule.name, rule.category, 'cookie-name');
      for (const c of matchedCookies) entry.domains.add(c.domain.replace(/^\./, ''));
    }
  }

  const consentTime = findConsentTimestamp(cookies);
  let consentRespected = true;
  if (aggregates.size > 0) {
    if (consentTime === null) {
      const anyFired = Array.from(aggregates.values()).some((e) => e.requestCount > 0);
      consentRespected = !anyFired;
    } else {
      consentRespected = Array.from(aggregates.values()).every(
        (e) => e.requestCount === 0 || e.firstRequestTime >= consentTime,
      );
    }
  }

  const byCategory = new Map<TrackerCategory, number>();
  let totalBytes = 0;
  let totalRequests = 0;
  const trackers: TrackerEntry[] = [];
  for (const entry of aggregates.values()) {
    byCategory.set(entry.category, (byCategory.get(entry.category) || 0) + 1);
    totalBytes += entry.bytesTransferred;
    totalRequests += entry.requestCount;
    trackers.push({
      name: entry.name,
      category: entry.category,
      domains: Array.from(entry.domains).sort(),
      requestCount: entry.requestCount,
      bytesTransferred: entry.bytesTransferred,
      scriptSourceUrls: Array.from(entry.scriptSourceUrls).sort(),
      detectedVia: entry.detectedVia,
    });
  }

  trackers.sort((a, b) => b.bytesTransferred - a.bytesTransferred || b.requestCount - a.requestCount || a.name.localeCompare(b.name));

  const stats = {
    total: trackers.length,
    byCategory: toRecord(byCategory),
    totalBytes,
    totalRequests,
  };

  return {
    page: pageUrl,
    trackers,
    stats,
    consentRespected,
    passed: stats.total === 0 || consentRespected,
  };
}
