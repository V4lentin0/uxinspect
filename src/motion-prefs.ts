import type { Page } from 'playwright';

export type MotionPrefsIssueType =
  | 'no-reduced-motion'
  | 'no-dark-mode'
  | 'no-print-css'
  | 'autoplay-video'
  | 'infinite-animation-unstoppable'
  | 'flashing-content';

export interface MotionPrefsIssue {
  type: MotionPrefsIssueType;
  target?: string;
  detail?: string;
}

export interface MotionPrefsResult {
  page: string;
  respectsReducedMotion: boolean;
  respectsDarkMode: boolean;
  respectsPrint: boolean;
  respectsForcedColors: boolean;
  animationsCount: number;
  autoplayVideos: number;
  infiniteAnimations: number;
  issues: MotionPrefsIssue[];
  passed: boolean;
}

export async function auditMotionPrefs(page: Page): Promise<MotionPrefsResult> {
  const url = page.url();

  const scan = await page.evaluate(() => {
    type IssueType =
      | 'no-reduced-motion'
      | 'no-dark-mode'
      | 'no-print-css'
      | 'autoplay-video'
      | 'infinite-animation-unstoppable'
      | 'flashing-content';

    interface Issue {
      type: IssueType;
      target?: string;
      detail?: string;
    }

    function buildSelector(el: Element): string {
      const id = el.id;
      if (id) return `#${CSS.escape(id)}`;
      const testid = el.getAttribute('data-testid');
      if (testid) return `[data-testid="${testid}"]`;
      const tag = el.tagName.toLowerCase();
      const classes = Array.from(el.classList).slice(0, 3);
      return classes.length ? `${tag}.${classes.map(c => CSS.escape(c)).join('.')}` : tag;
    }

    let respectsReducedMotion = false;
    let respectsDarkMode = false;
    let respectsPrint = false;
    let respectsForcedColors = false;
    let infiniteAnimations = 0;
    const flashingSelectors: Array<{ target: string; detail: string }> = [];

    function walkRules(rules: CSSRuleList | undefined, inReducedMotion: boolean) {
      if (!rules) return;
      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i];
        if (rule instanceof CSSMediaRule) {
          const mediaText = rule.conditionText || rule.media.mediaText || '';
          const lower = mediaText.toLowerCase();
          let reducedMotionBranch = inReducedMotion;
          if (lower.includes('(prefers-reduced-motion')) {
            respectsReducedMotion = true;
            reducedMotionBranch = true;
          }
          if (lower.includes('(prefers-color-scheme: dark')) {
            respectsDarkMode = true;
          }
          if (lower.includes('(forced-colors')) {
            respectsForcedColors = true;
          }
          if (/(^|[^a-z])print([^a-z]|$)/.test(lower)) {
            respectsPrint = true;
          }
          walkRules(rule.cssRules, reducedMotionBranch);
          continue;
        }
        if (rule instanceof CSSStyleRule) {
          const style = rule.style;
          const iter = style.getPropertyValue('animation-iteration-count').trim();
          const shorthand = style.getPropertyValue('animation').trim();
          const isInfinite = iter === 'infinite' || /\binfinite\b/.test(shorthand);
          if (isInfinite) {
            infiniteAnimations++;
            const durRaw =
              style.getPropertyValue('animation-duration').trim() ||
              (shorthand.match(/([\d.]+)(ms|s)\b/)?.[0] ?? '');
            const durMs = parseDurationMs(durRaw);
            if (durMs !== null && durMs > 0 && durMs < 500 && !inReducedMotion) {
              flashingSelectors.push({
                target: rule.selectorText,
                detail: `animation-duration ${durRaw} with infinite iteration`,
              });
            }
          }
          continue;
        }
        if (
          rule instanceof CSSSupportsRule ||
          (typeof CSSContainerRule !== 'undefined' && rule instanceof CSSContainerRule) ||
          (typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule)
        ) {
          walkRules((rule as unknown as { cssRules: CSSRuleList }).cssRules, inReducedMotion);
        }
      }
    }

    function parseDurationMs(raw: string): number | null {
      if (!raw) return null;
      const m = raw.match(/([\d.]+)(ms|s)/);
      if (!m) return null;
      const n = parseFloat(m[1]);
      if (!isFinite(n)) return null;
      return m[2] === 's' ? n * 1000 : n;
    }

    for (const sheet of Array.from(document.styleSheets)) {
      try {
        walkRules(sheet.cssRules, false);
      } catch {
        // cross-origin stylesheet — skip
      }
    }

    const animations =
      typeof document.getAnimations === 'function' ? document.getAnimations().length : 0;

    const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    const autoplayBad: Array<{ target: string; detail: string }> = [];
    let autoplayCount = 0;
    for (const v of videos) {
      const hasAutoplay = v.hasAttribute('autoplay') || v.autoplay;
      if (!hasAutoplay) continue;
      autoplayCount++;
      const muted = v.muted || v.hasAttribute('muted');
      const hasAudio =
        (typeof (v as HTMLVideoElement & { mozHasAudio?: boolean }).mozHasAudio === 'boolean'
          ? (v as HTMLVideoElement & { mozHasAudio?: boolean }).mozHasAudio
          : undefined) ??
        ((v as HTMLVideoElement & { webkitAudioDecodedByteCount?: number })
          .webkitAudioDecodedByteCount ?? 0) > 0;
      const assumedAudio = hasAudio || !muted;
      if (!muted && assumedAudio) {
        autoplayBad.push({
          target: buildSelector(v),
          detail: 'video[autoplay] is not muted (may play audio without consent)',
        });
      }
    }

    const issues: Issue[] = [];
    if (!respectsReducedMotion) {
      issues.push({
        type: 'no-reduced-motion',
        detail: 'No @media (prefers-reduced-motion) rules found',
      });
    }
    if (!respectsDarkMode) {
      issues.push({
        type: 'no-dark-mode',
        detail: 'No @media (prefers-color-scheme: dark) rules found',
      });
    }
    if (!respectsPrint) {
      issues.push({
        type: 'no-print-css',
        detail: 'No @media print rules found',
      });
    }
    for (const a of autoplayBad) {
      issues.push({ type: 'autoplay-video', target: a.target, detail: a.detail });
    }
    if (infiniteAnimations > 0 && !respectsReducedMotion) {
      issues.push({
        type: 'infinite-animation-unstoppable',
        detail: `${infiniteAnimations} infinite animation(s) with no prefers-reduced-motion handling`,
      });
    }
    for (const f of flashingSelectors) {
      issues.push({ type: 'flashing-content', target: f.target, detail: f.detail });
    }

    return {
      respectsReducedMotion,
      respectsDarkMode,
      respectsPrint,
      respectsForcedColors,
      animationsCount: animations,
      autoplayVideos: autoplayCount,
      infiniteAnimations,
      issues,
    };
  });

  const blocking = scan.issues.some(
    i => i.type === 'autoplay-video' || i.type === 'flashing-content'
  );

  return {
    page: url,
    respectsReducedMotion: scan.respectsReducedMotion,
    respectsDarkMode: scan.respectsDarkMode,
    respectsPrint: scan.respectsPrint,
    respectsForcedColors: scan.respectsForcedColors,
    animationsCount: scan.animationsCount,
    autoplayVideos: scan.autoplayVideos,
    infiniteAnimations: scan.infiniteAnimations,
    issues: scan.issues,
    passed: !blocking,
  };
}
