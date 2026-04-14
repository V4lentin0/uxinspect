import type { Page } from 'playwright';

export type PaginationKind = 'numbered' | 'prev-next' | 'load-more' | 'infinite-scroll' | 'none';

export type PaginationIssueType =
  | 'no-nav-landmark'
  | 'missing-aria-label'
  | 'current-page-not-marked'
  | 'link-without-href'
  | 'infinite-scroll-no-load-more'
  | 'infinite-scroll-no-url-update'
  | 'infinite-scroll-traps-focus'
  | 'load-more-without-aria-live'
  | 'back-button-broken'
  | 'no-total-count';

export interface PaginationIssue {
  type: PaginationIssueType;
  severity: 'info' | 'warn' | 'error';
  selector?: string;
  detail: string;
}

export interface PaginationResult {
  page: string;
  kind: PaginationKind;
  detected: boolean;
  pageCountDetected?: number;
  hasNavLandmark: boolean;
  supportsKeyboard: boolean;
  updatesUrl: boolean;
  issues: PaginationIssue[];
  passed: boolean;
}

interface DetectionResult {
  kind: PaginationKind;
  detected: boolean;
  pageCountDetected?: number;
  hasNavLandmark: boolean;
  navHasLabel: boolean;
  controlSelector?: string;
  loadMoreSelector?: string;
  hasCurrentMark: boolean;
  linksWithoutHref: number;
  hasTotalCount: boolean;
  hasAriaLive: boolean;
  initialScrollHeight: number;
  initialItemCount: number;
  containerSelector?: string;
  firstFocusSelector?: string;
}

interface ProbeResult {
  scrollHeight: number;
  itemCount: number;
  url: string;
  activeIsBody: boolean;
}

interface SnapState {
  count: number;
  height: number;
}

export async function auditPagination(
  page: Page,
  opts?: { scrollProbes?: number },
): Promise<PaginationResult> {
  const url = page.url();
  const probes = Math.max(1, opts?.scrollProbes ?? 2);

  const detection: DetectionResult = await page.evaluate((): DetectionResult => {
    const sel = (el: Element): string => {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const tid = el.getAttribute('data-testid');
      if (tid) return `[data-testid="${tid}"]`;
      const tag = el.tagName.toLowerCase();
      const cls = Array.from(el.classList).slice(0, 2);
      return cls.length ? `${tag}.${cls.map((c) => CSS.escape(c)).join('.')}` : tag;
    };

    const NUM_RE = /^\d+$/;
    const LOADMORE_RE = /(load more|show more|see more)/i;
    const TOTAL_RE = /(\bof\s+\d+|\d+\s*\/\s*\d+|page\s+\d+\s+of\s+\d+)/i;
    const CURRENT_CLS_RE = /(\bactive\b|\bcurrent\b|\bis-active\b|\bis-current\b)/;

    let numberedNav: Element | null = null;
    let pageCount = 0;
    for (const nav of Array.from(document.querySelectorAll('nav'))) {
      const nums = Array.from(nav.querySelectorAll('a, button')).filter((l) => NUM_RE.test((l.textContent || '').trim()));
      if (nums.length >= 2) {
        let max = 0;
        for (const n of nums) {
          const v = parseInt((n.textContent || '').trim(), 10);
          if (Number.isFinite(v) && v > max) max = v;
        }
        numberedNav = nav;
        pageCount = max;
        break;
      }
    }

    const findCurrent = (root: Element): boolean => {
      if (root.querySelector('[aria-current="page"]')) return true;
      for (const c of Array.from(root.querySelectorAll('a, button, span, li'))) {
        const cls = typeof c.className === 'string' ? c.className.toLowerCase() : '';
        if (CURRENT_CLS_RE.test(cls)) return true;
      }
      return false;
    };

    let prev: Element | null = null;
    let next: Element | null = null;
    for (const c of Array.from(document.querySelectorAll('a, button'))) {
      const t = ((c.textContent || '') + ' ' + (c.getAttribute('aria-label') || '')).trim();
      if (!t) continue;
      if (/previous|prev/i.test(t) && !prev) prev = c;
      if (/next/i.test(t) && !next) next = c;
      if (prev && next) break;
    }
    const prevNext: Element | null = next || prev;

    let loadMore: Element | null = null;
    for (const b of Array.from(document.querySelectorAll('button, a'))) {
      const t = (b.textContent || '').trim();
      const l = b.getAttribute('aria-label') || '';
      if (LOADMORE_RE.test(t) || LOADMORE_RE.test(l)) { loadMore = b; break; }
    }

    let kind: PaginationKind = 'none';
    let detected = false;
    let hasNavLandmark = false;
    let navHasLabel = false;
    let controlSelector: string | undefined;
    let loadMoreSelector: string | undefined;
    let hasCurrentMark = false;
    let linksWithoutHref = 0;
    let firstFocusSelector: string | undefined;
    let pageCountDetected: number | undefined;
    const labelOf = (n: Element): boolean => n.hasAttribute('aria-label') || n.hasAttribute('aria-labelledby');

    if (numberedNav && findCurrent(numberedNav)) {
      kind = 'numbered';
      detected = true;
      hasNavLandmark = numberedNav.tagName.toLowerCase() === 'nav';
      navHasLabel = labelOf(numberedNav);
      pageCountDetected = pageCount;
      controlSelector = sel(numberedNav);
      hasCurrentMark = true;
      for (const l of Array.from(numberedNav.querySelectorAll('a'))) {
        if (!l.hasAttribute('href')) linksWithoutHref++;
      }
      const ff = numberedNav.querySelector('a, button');
      if (ff) firstFocusSelector = sel(ff);
    } else if (prevNext) {
      kind = 'prev-next';
      detected = true;
      const wrap = prevNext.closest('nav');
      hasNavLandmark = !!wrap;
      if (wrap) navHasLabel = labelOf(wrap);
      controlSelector = sel(prevNext);
      hasCurrentMark = wrap ? findCurrent(wrap) : false;
      if (prevNext.tagName.toLowerCase() === 'a' && !prevNext.hasAttribute('href')) linksWithoutHref++;
      firstFocusSelector = controlSelector;
    } else if (loadMore) {
      kind = 'load-more';
      detected = true;
      loadMoreSelector = sel(loadMore);
      const wrap = loadMore.closest('nav');
      hasNavLandmark = !!wrap;
      if (wrap) navHasLabel = labelOf(wrap);
      firstFocusSelector = loadMoreSelector;
    }

    if (!loadMoreSelector && loadMore) loadMoreSelector = sel(loadMore);

    let container: Element | null = null;
    let bestCount = 0;
    for (const l of Array.from(document.querySelectorAll('ul, ol, [role="list"], [role="feed"]'))) {
      if (l.children.length > bestCount && l.children.length >= 3) {
        bestCount = l.children.length;
        container = l;
      }
    }
    if (!container) {
      for (const c of Array.from(document.querySelectorAll('main, section, div'))) {
        const tags = new Map<string, number>();
        for (const ch of Array.from(c.children)) {
          const t = ch.tagName.toLowerCase();
          tags.set(t, (tags.get(t) || 0) + 1);
        }
        for (const [, count] of tags) {
          if (count >= 5 && count > bestCount) { bestCount = count; container = c; }
        }
      }
    }

    const hasTotalCount = TOTAL_RE.test(document.body.textContent || '');
    const hasAriaLive = !!document.querySelector(
      '[aria-live="polite"],[aria-live="assertive"],[role="status"],[role="alert"],[role="log"]',
    );

    return {
      kind,
      detected,
      hasNavLandmark,
      navHasLabel,
      hasCurrentMark,
      linksWithoutHref,
      hasTotalCount,
      hasAriaLive,
      initialScrollHeight: document.body.scrollHeight,
      initialItemCount: container ? container.children.length : 0,
      ...(pageCountDetected !== undefined ? { pageCountDetected } : {}),
      ...(controlSelector !== undefined ? { controlSelector } : {}),
      ...(loadMoreSelector !== undefined ? { loadMoreSelector } : {}),
      ...(container ? { containerSelector: sel(container) } : {}),
      ...(firstFocusSelector !== undefined ? { firstFocusSelector } : {}),
    };
  });

  const issues: PaginationIssue[] = [];
  let kind = detection.kind;
  let updatesUrl = false;
  let supportsKeyboard = false;
  let focusLost = false;

  let prevHeight = detection.initialScrollHeight;
  let prevCount = detection.initialItemCount;
  let prevUrl = url;
  let scrollGrew = false;

  for (let i = 0; i < probes; i++) {
    await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); });
    await page.waitForTimeout(1500);
    const probe: ProbeResult = await page.evaluate((cs: string | null): ProbeResult => {
      let count = 0;
      if (cs) { const c = document.querySelector(cs); if (c) count = c.children.length; }
      const a = document.activeElement;
      return { scrollHeight: document.body.scrollHeight, itemCount: count, url: window.location.href, activeIsBody: !a || a === document.body };
    }, detection.containerSelector ?? null);

    if (probe.scrollHeight > prevHeight + 10 || probe.itemCount > prevCount) {
      scrollGrew = true;
      if (probe.activeIsBody) focusLost = true;
    }
    if (probe.url !== prevUrl) updatesUrl = true;

    prevHeight = probe.scrollHeight;
    prevCount = probe.itemCount;
    prevUrl = probe.url;
  }

  if (!detection.detected && scrollGrew) kind = 'infinite-scroll';

  const snap = (cs: string | null): Promise<SnapState> =>
    page.evaluate((s: string | null): SnapState => {
      let count = 0;
      if (s) {
        const c = document.querySelector(s);
        if (c) count = c.children.length;
      }
      return { count, height: document.body.scrollHeight };
    }, cs);

  if ((kind === 'numbered' || kind === 'prev-next' || kind === 'load-more') && detection.firstFocusSelector) {
    try {
      const handle = await page.$(detection.firstFocusSelector);
      if (handle) {
        await handle.focus();
        const beforeUrl = page.url();
        const before = await snap(detection.containerSelector ?? null);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(800);
        const afterUrl = page.url();
        const after = await snap(detection.containerSelector ?? null);
        if (afterUrl !== beforeUrl || after.count !== before.count || after.height !== before.height) {
          supportsKeyboard = true;
        }
        if (afterUrl !== beforeUrl) updatesUrl = true;
      }
    } catch {
      // ignore navigation errors during keyboard probe
    }
  }

  const cSel = detection.controlSelector;
  const lmSel = detection.loadMoreSelector;
  const push = (
    type: PaginationIssueType,
    severity: PaginationIssue['severity'],
    detail: string,
    selector?: string,
  ): void => {
    issues.push({ type, severity, detail, ...(selector ? { selector } : {}) });
  };

  if (kind === 'numbered') {
    if (!detection.hasNavLandmark) push('no-nav-landmark', 'warn', 'Numbered pagination is not wrapped in a <nav> landmark', cSel);
    else if (!detection.navHasLabel) push('missing-aria-label', 'warn', '<nav> wrapping pagination has no aria-label or aria-labelledby', cSel);
    if (!detection.hasCurrentMark) push('current-page-not-marked', 'error', 'Current page is not marked with aria-current="page"', cSel);
    if (detection.linksWithoutHref > 0) push('link-without-href', 'error', `${detection.linksWithoutHref} pagination <a> element(s) have no href`, cSel);
    if (!detection.hasTotalCount) push('no-total-count', 'info', 'Numbered pagination has no visible total count (e.g. "Page X of Y")');
  }

  if (kind === 'prev-next') {
    if (!detection.hasNavLandmark) push('no-nav-landmark', 'warn', 'Prev/next pagination is not wrapped in a <nav> landmark', cSel);
    else if (!detection.navHasLabel) push('missing-aria-label', 'warn', '<nav> wrapping prev/next has no aria-label or aria-labelledby', cSel);
    if (detection.linksWithoutHref > 0) push('link-without-href', 'error', 'Prev/next link element has no href attribute', cSel);
  }

  if (kind === 'load-more' && !detection.hasAriaLive) {
    push('load-more-without-aria-live', 'info', 'Load-more control found but no aria-live region exists to announce new content', lmSel);
  }

  if (kind === 'infinite-scroll') {
    if (!lmSel) push('infinite-scroll-no-load-more', 'warn', 'Infinite-scroll detected but no fallback "load more" button is present');
    if (!updatesUrl) {
      push('infinite-scroll-no-url-update', 'warn', 'Infinite-scroll appended content but URL did not change (deep links not preserved)');
      push('back-button-broken', 'warn', 'No history.pushState detected during scroll — back button will not return to scroll position');
    }
    if (focusLost) push('infinite-scroll-traps-focus', 'info', 'Content was appended but document focus reverted to <body>');
    if (!detection.hasAriaLive) push('load-more-without-aria-live', 'info', 'Infinite-scroll appended content but no aria-live region announces it');
  }

  const passed = issues.every((i) => i.severity !== 'error');

  const result: PaginationResult = {
    page: url,
    kind,
    detected: detection.detected || kind === 'infinite-scroll',
    hasNavLandmark: detection.hasNavLandmark,
    supportsKeyboard,
    updatesUrl,
    issues,
    passed,
  };
  if (detection.pageCountDetected !== undefined) {
    result.pageCountDetected = detection.pageCountDetected;
  }
  return result;
}
