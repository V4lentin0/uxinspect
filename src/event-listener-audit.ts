import type { Page } from 'playwright';

// Post-hoc limitation: listeners attached via addEventListener are NOT enumerable from script context;
// this audit only sees inline on* attributes and window-level on* properties.

export type EventListenerIssueType =
  | 'non-passive-scroll-handler'
  | 'non-passive-touch-handler'
  | 'non-passive-wheel-handler'
  | 'too-many-listeners'
  | 'global-unload-handler';

export interface EventListenerIssue {
  type: EventListenerIssueType;
  detail: string;
  target?: string;
}

export interface EventListenerTypeBucket {
  type: string;
  count: number;
  passive: number;
}

export interface EventListenerAuditResult {
  page: string;
  totalListeners: number;
  passiveScrollRatio: number;
  byType: EventListenerTypeBucket[];
  issues: EventListenerIssue[];
  passed: boolean;
}

interface RawHandler {
  eventType: string;
  target: string;
  source: 'inline' | 'window-prop';
}

interface RawAudit {
  handlers: RawHandler[];
  windowUnloadSet: boolean;
  windowBeforeUnloadSet: boolean;
}

const SCROLL_TYPES = new Set<string>(['scroll']);
const WHEEL_TYPES = new Set<string>(['wheel', 'mousewheel']);
const TOUCH_TYPES = new Set<string>(['touchstart', 'touchmove', 'touchend', 'touchcancel']);

export async function auditEventListeners(page: Page): Promise<EventListenerAuditResult> {
  const raw: RawAudit = await page.evaluate(() => {
    const shortSelector = (el: Element): string => {
      let s = el.tagName.toLowerCase();
      if (el.id) s += `#${el.id}`;
      const firstClass = el.classList?.[0];
      if (firstClass) s += `.${firstClass}`;
      return s;
    };

    const handlers: RawHandler[] = [];

    const all = document.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (!el) continue;
      const attrs = el.attributes;
      for (let j = 0; j < attrs.length; j++) {
        const attr = attrs[j];
        if (!attr) continue;
        const name = attr.name;
        if (name.length > 2 && name.charCodeAt(0) === 111 /* o */ && name.charCodeAt(1) === 110 /* n */) {
          handlers.push({
            eventType: name.slice(2),
            target: shortSelector(el),
            source: 'inline',
          });
        }
      }
    }

    const winEventProps = [
      'onscroll',
      'onwheel',
      'ontouchstart',
      'ontouchmove',
      'ontouchend',
      'ontouchcancel',
      'onbeforeunload',
      'onunload',
      'onpagehide',
      'onpageshow',
      'onresize',
      'onerror',
      'onmessage',
      'onhashchange',
      'onpopstate',
      'onblur',
      'onfocus',
    ];

    const w = window as unknown as Record<string, unknown>;
    for (const prop of winEventProps) {
      if (typeof w[prop] === 'function') {
        handlers.push({
          eventType: prop.slice(2),
          target: 'window',
          source: 'window-prop',
        });
      }
    }

    const windowUnloadSet = typeof w['onunload'] === 'function';
    const windowBeforeUnloadSet = typeof w['onbeforeunload'] === 'function';

    return {
      handlers,
      windowUnloadSet,
      windowBeforeUnloadSet,
    } as RawAudit;
  });

  const byTypeMap = new Map<string, EventListenerTypeBucket>();
  for (const h of raw.handlers) {
    const key = h.eventType.toLowerCase();
    let bucket = byTypeMap.get(key);
    if (!bucket) {
      bucket = { type: key, count: 0, passive: 0 };
      byTypeMap.set(key, bucket);
    }
    bucket.count += 1;
    // inline handlers and window on* properties are never passive
  }

  const byType = Array.from(byTypeMap.values()).sort((a, b) => b.count - a.count);
  const totalListeners = raw.handlers.length;

  // addEventListener passivity is not observable post-hoc; inline on* handlers are never passive.
  const passiveScrollRatio = 0;

  const issues: EventListenerIssue[] = [];
  const MAX_TARGETS_PER_ISSUE = 10;

  const collectTargets = (predicate: (eventType: string) => boolean): string[] => {
    const seen = new Set<string>();
    const targets: string[] = [];
    for (const h of raw.handlers) {
      if (!predicate(h.eventType.toLowerCase())) continue;
      if (seen.has(h.target)) continue;
      seen.add(h.target);
      targets.push(h.target);
      if (targets.length >= MAX_TARGETS_PER_ISSUE) break;
    }
    return targets;
  };

  const scrollTargets = collectTargets((t) => SCROLL_TYPES.has(t));
  if (scrollTargets.length > 0) {
    issues.push({
      type: 'non-passive-scroll-handler',
      detail: `inline scroll handler detected; inline on* handlers cannot be passive (addEventListener passivity not observable post-hoc) [${scrollTargets.length} target${scrollTargets.length === 1 ? '' : 's'}]`,
      target: scrollTargets.join(', '),
    });
  }

  const wheelTargets = collectTargets((t) => WHEEL_TYPES.has(t));
  if (wheelTargets.length > 0) {
    issues.push({
      type: 'non-passive-wheel-handler',
      detail: `inline wheel handler detected; inline on* handlers cannot be passive (addEventListener passivity not observable post-hoc) [${wheelTargets.length} target${wheelTargets.length === 1 ? '' : 's'}]`,
      target: wheelTargets.join(', '),
    });
  }

  const touchTargets = collectTargets((t) => TOUCH_TYPES.has(t));
  if (touchTargets.length > 0) {
    issues.push({
      type: 'non-passive-touch-handler',
      detail: `inline touch handler detected; inline on* handlers cannot be passive (addEventListener passivity not observable post-hoc) [${touchTargets.length} target${touchTargets.length === 1 ? '' : 's'}]`,
      target: touchTargets.join(', '),
    });
  }

  if (totalListeners > 500) {
    issues.push({
      type: 'too-many-listeners',
      detail: `${totalListeners} observable handlers exceed limit 500`,
    });
  }

  if (raw.windowBeforeUnloadSet || raw.windowUnloadSet) {
    const which: string[] = [];
    if (raw.windowBeforeUnloadSet) which.push('beforeunload');
    if (raw.windowUnloadSet) which.push('unload');
    issues.push({
      type: 'global-unload-handler',
      detail: `window ${which.join(' + ')} handler is set; blocks bfcache and hurts navigation perf`,
      target: 'window',
    });
  }

  return {
    page: page.url(),
    totalListeners,
    passiveScrollRatio,
    byType,
    issues,
    passed: issues.length === 0,
  };
}
