import type { Page } from 'playwright';

export interface CookieBannerIssue {
  type: 'no-banner' | 'no-reject-button' | 'cookies-before-consent' | 'trackers-before-consent' | 'dark-pattern';
  detail: string;
}

export interface CookieBannerCookie {
  name: string;
  domain: string;
  value: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
}

export interface CookieBannerResult {
  page: string;
  bannerDetected: boolean;
  bannerSelector?: string;
  hasAcceptButton: boolean;
  hasRejectButton: boolean;
  hasSettingsButton: boolean;
  beforeConsentCookies: CookieBannerCookie[];
  beforeConsentTrackers: string[];
  issues: CookieBannerIssue[];
  passed: boolean;
}

interface ButtonInfo {
  text: string;
  area: number;
  brightness: number;
}

interface BannerSnapshot {
  detected: boolean;
  selector?: string;
  matchedText?: string;
  acceptButton?: ButtonInfo;
  rejectButton?: ButtonInfo;
  settingsButton?: ButtonInfo;
  trackerResources: string[];
}

const KNOWN_BANNER_IDS = [
  '#cookie-banner',
  '#cookie-notice',
  '#gdpr-banner',
  '.cookie-consent',
  '#onetrust-banner-sdk',
  '#CybotCookiebotDialog',
  '#cookieConsent',
  '#cookie-law-info-bar',
  '.cc-window',
  '.cky-consent-container',
  '#cmpbox',
  '#usercentrics-root',
];

const TRACKER_DOMAINS = [
  'google-analytics.com',
  'googletagmanager.com',
  'facebook.net',
  'doubleclick.net',
  'hotjar.com',
  'mixpanel.com',
  'segment.com',
  'intercom.io',
  'fullstory.com',
  'clarity.ms',
  'clicky.com',
  'amplitude.com',
  'heap.io',
];

const TRACKER_COOKIE_PATTERNS: Array<{ pattern: RegExp; vendor: string }> = [
  { pattern: /^_ga(_|$)/, vendor: 'google-analytics' },
  { pattern: /^_gid$/, vendor: 'google-analytics' },
  { pattern: /^_gat/, vendor: 'google-analytics' },
  { pattern: /^_fbp$/, vendor: 'facebook' },
  { pattern: /^_fbc$/, vendor: 'facebook' },
  { pattern: /^fr$/, vendor: 'facebook' },
  { pattern: /^_pin_unauth$/, vendor: 'pinterest' },
  { pattern: /^_hjid$/, vendor: 'hotjar' },
  { pattern: /^_hjSession/, vendor: 'hotjar' },
  { pattern: /^_scid$/, vendor: 'snapchat' },
  { pattern: /^_ttp$/, vendor: 'tiktok' },
  { pattern: /^mp_/, vendor: 'mixpanel' },
  { pattern: /^amplitude_/, vendor: 'amplitude' },
  { pattern: /^intercom-/, vendor: 'intercom' },
  { pattern: /^ajs_/, vendor: 'segment' },
  { pattern: /^_uetsid$/, vendor: 'bing' },
  { pattern: /^_uetvid$/, vendor: 'bing' },
  { pattern: /^IDE$/, vendor: 'doubleclick' },
  { pattern: /^MUID$/, vendor: 'bing' },
];

const ACCEPT_RX = /\b(accept|allow|agree|got it|i understand|i agree|ok|okay|continue|yes)\b/i;
const REJECT_RX = /\b(reject|decline|deny|refuse|no thanks|disagree|opt[- ]?out)\b/i;
const SETTINGS_RX = /\b(settings|customi[sz]e|preferences|manage|options|choose|configure|more info)\b/i;
const BANNER_TEXT_RX = /cookie|gdpr|privacy|consent/i;

export async function auditCookieBanner(page: Page): Promise<CookieBannerResult> {
  const pageUrl = page.url();

  const beforeCookies = await page.context().cookies();

  const snapshot = await page.evaluate(
    ({
      knownIds,
      trackerDomains,
      acceptSrc,
      rejectSrc,
      settingsSrc,
      bannerTextSrc,
    }: {
      knownIds: string[];
      trackerDomains: string[];
      acceptSrc: string;
      rejectSrc: string;
      settingsSrc: string;
      bannerTextSrc: string;
    }): BannerSnapshot => {
      const acceptRx = new RegExp(acceptSrc, 'i');
      const rejectRx = new RegExp(rejectSrc, 'i');
      const settingsRx = new RegExp(settingsSrc, 'i');
      const bannerRx = new RegExp(bannerTextSrc, 'i');

      const cssPath = (el: Element): string => {
        if (el.id) return `#${el.id}`;
        const parts: string[] = [];
        let node: Element | null = el;
        let depth = 0;
        while (node && depth < 4) {
          const name = node.nodeName.toLowerCase();
          const parent: Element | null = node.parentElement;
          if (!parent) { parts.unshift(name); break; }
          const current: Element = node;
          const sibs: Element[] = Array.from(parent.children).filter((c: Element) => c.nodeName === current.nodeName);
          const idx = sibs.indexOf(current) + 1;
          parts.unshift(sibs.length > 1 ? `${name}:nth-of-type(${idx})` : name);
          node = parent;
          depth++;
        }
        return parts.join(' > ');
      };

      const isVisible = (el: Element): boolean => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;
        const style = window.getComputedStyle(el as HTMLElement);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') < 0.05) return false;
        return true;
      };

      const looksLikeBanner = (el: Element): boolean => {
        const style = window.getComputedStyle(el as HTMLElement);
        const pos = style.position;
        const z = parseInt(style.zIndex || '0', 10);
        if (pos === 'fixed' || pos === 'sticky') return true;
        if (!Number.isNaN(z) && z > 1000) return true;
        return false;
      };

      // 1. Try known selectors first
      let banner: Element | null = null;
      let matchedSelector: string | undefined;
      for (const sel of knownIds) {
        const found = document.querySelector(sel);
        if (found && isVisible(found)) {
          banner = found;
          matchedSelector = sel;
          break;
        }
      }

      // 2. Fallback: scan visible fixed/high-z elements with banner-ish text
      let matchedText: string | undefined;
      if (!banner) {
        const candidates = Array.from(document.querySelectorAll<HTMLElement>('div, section, aside, footer, header, dialog'));
        for (const el of candidates) {
          if (!isVisible(el)) continue;
          if (!looksLikeBanner(el)) continue;
          const text = (el.textContent || '').trim().slice(0, 500);
          if (!text) continue;
          if (!bannerRx.test(text)) continue;
          // Avoid huge containers that hold the whole page
          const rect = el.getBoundingClientRect();
          if (rect.height > window.innerHeight * 0.9 && rect.width > window.innerWidth * 0.9) continue;
          banner = el;
          matchedSelector = cssPath(el);
          matchedText = text.slice(0, 120);
          break;
        }
      }

      const buttonInfo = (el: Element): ButtonInfo => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        const bg = style.backgroundColor || 'rgba(0,0,0,0)';
        const m = bg.match(/rgba?\(([^)]+)\)/);
        let brightness = 0;
        if (m) {
          const parts = m[1].split(',').map((p) => parseFloat(p.trim()));
          const [r, g, b, a = 1] = parts;
          if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
            brightness = ((r * 299 + g * 587 + b * 114) / 1000) * (Number.isNaN(a) ? 1 : a);
          }
        }
        return {
          text: (el.textContent || '').trim().slice(0, 80),
          area: Math.max(0, rect.width * rect.height),
          brightness,
        };
      };

      let acceptButton: ButtonInfo | undefined;
      let rejectButton: ButtonInfo | undefined;
      let settingsButton: ButtonInfo | undefined;

      if (banner) {
        const clickables = Array.from(
          banner.querySelectorAll<HTMLElement>('button, a, [role="button"], input[type="button"], input[type="submit"]'),
        ).filter((el) => isVisible(el));

        for (const el of clickables) {
          const raw = (el.textContent || el.getAttribute('aria-label') || (el as HTMLInputElement).value || '').trim();
          if (!raw) continue;
          if (!acceptButton && acceptRx.test(raw) && !rejectRx.test(raw)) {
            acceptButton = buttonInfo(el);
            continue;
          }
          if (!rejectButton && rejectRx.test(raw)) {
            rejectButton = buttonInfo(el);
            continue;
          }
          if (!settingsButton && settingsRx.test(raw)) {
            settingsButton = buttonInfo(el);
            continue;
          }
        }
      }

      // Resource list: tracker-domain hits
      const trackerResources: string[] = [];
      const seen = new Set<string>();
      const perfEntries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      for (const entry of perfEntries) {
        const name = entry.name || '';
        for (const domain of trackerDomains) {
          if (name.includes(domain)) {
            if (!seen.has(domain)) {
              trackerResources.push(domain);
              seen.add(domain);
            }
            break;
          }
        }
      }

      return {
        detected: !!banner,
        selector: matchedSelector,
        matchedText,
        acceptButton,
        rejectButton,
        settingsButton,
        trackerResources,
      };
    },
    {
      knownIds: KNOWN_BANNER_IDS,
      trackerDomains: TRACKER_DOMAINS,
      acceptSrc: ACCEPT_RX.source,
      rejectSrc: REJECT_RX.source,
      settingsSrc: SETTINGS_RX.source,
      bannerTextSrc: BANNER_TEXT_RX.source,
    },
  );

  const beforeConsentCookies: CookieBannerCookie[] = [];
  for (const c of beforeCookies) {
    const matchesTracker = TRACKER_COOKIE_PATTERNS.some((t) => t.pattern.test(c.name));
    if (matchesTracker) {
      const ss = (c as { sameSite?: string }).sameSite;
      beforeConsentCookies.push({
        name: c.name,
        domain: c.domain,
        value: c.value,
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        sameSite: ss && ss !== '' ? ss : undefined,
      });
    }
  }

  const beforeConsentTrackers = snapshot.trackerResources;

  const issues: CookieBannerIssue[] = [];

  if (!snapshot.detected) {
    if (beforeConsentTrackers.length > 0 || beforeConsentCookies.length > 0) {
      issues.push({
        type: 'no-banner',
        detail: `no cookie consent banner detected, but ${beforeConsentTrackers.length} tracker domain(s) and ${beforeConsentCookies.length} tracking cookie(s) already active`,
      });
    }
  } else {
    if (!snapshot.rejectButton) {
      issues.push({
        type: 'no-reject-button',
        detail: 'banner has no reject/decline option — GDPR requires equal prominence for refusing consent',
      });
    }
  }

  if (beforeConsentTrackers.length > 0) {
    issues.push({
      type: 'trackers-before-consent',
      detail: `tracker resources loaded before user consent: ${beforeConsentTrackers.join(', ')}`,
    });
  }

  if (beforeConsentCookies.length > 0) {
    const names = beforeConsentCookies.map((c) => c.name).join(', ');
    issues.push({
      type: 'cookies-before-consent',
      detail: `non-essential cookies set before user interaction: ${names}`,
    });
  }

  if (snapshot.detected && snapshot.acceptButton && snapshot.rejectButton) {
    const a = snapshot.acceptButton;
    const r = snapshot.rejectButton;
    const areaRatio = r.area > 0 ? a.area / r.area : Infinity;
    const brightnessDelta = a.brightness - r.brightness;
    if (areaRatio >= 1.5 || (brightnessDelta >= 60 && r.brightness < 50)) {
      issues.push({
        type: 'dark-pattern',
        detail: `accept button disproportionately prominent vs reject (area ratio ${areaRatio.toFixed(2)}, brightness delta ${brightnessDelta.toFixed(0)})`,
      });
    }
  }

  return {
    page: pageUrl,
    bannerDetected: snapshot.detected,
    bannerSelector: snapshot.selector,
    hasAcceptButton: !!snapshot.acceptButton,
    hasRejectButton: !!snapshot.rejectButton,
    hasSettingsButton: !!snapshot.settingsButton,
    beforeConsentCookies,
    beforeConsentTrackers,
    issues,
    passed: issues.length === 0,
  };
}
