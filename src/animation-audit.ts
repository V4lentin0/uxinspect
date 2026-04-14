import type { Page } from 'playwright';

export type AnimationIssueType =
  | 'infinite-animation-no-reduced-motion-fallback'
  | 'long-animation'
  | 'non-composited-property'
  | 'too-many-animations';

export interface AnimationIssue {
  type: AnimationIssueType;
  detail: string;
  target?: string;
}

export interface AnimationInfo {
  target: string;
  name?: string;
  duration: number;
  iterations: number;
  animatedProperty?: string;
}

export interface AnimationAuditResult {
  page: string;
  cssAnimations: AnimationInfo[];
  jsAnimations: AnimationInfo[];
  infiniteAnimations: number;
  prefersReducedMotionHonored: boolean;
  issues: AnimationIssue[];
  passed: boolean;
}

interface AnimationScanResult {
  cssAnimations: AnimationInfo[];
  jsAnimations: AnimationInfo[];
  infiniteAnimations: number;
  prefersReducedMotionHonored: boolean;
  issues: AnimationIssue[];
}

const MAX_ENTRIES = 30;

export async function auditAnimations(page: Page): Promise<AnimationAuditResult> {
  const url = page.url();

  const scan: AnimationScanResult = await page.evaluate((): AnimationScanResult => {
    type IssueType =
      | 'infinite-animation-no-reduced-motion-fallback'
      | 'long-animation'
      | 'non-composited-property'
      | 'too-many-animations';

    interface Info {
      target: string;
      name?: string;
      duration: number;
      iterations: number;
      animatedProperty?: string;
    }

    interface Issue {
      type: IssueType;
      detail: string;
      target?: string;
    }

    const SENTINEL = 9999;
    const LIMIT = 30;
    const LONG_MS = 5000;
    const MAX_TOTAL = 20;
    const COMPOSITED = new Set<string>(['opacity', 'transform', 'filter']);

    function buildSelector(el: Element): string {
      const id = el.id;
      if (id) return `#${CSS.escape(id)}`;
      const testid = el.getAttribute('data-testid');
      if (testid) return `[data-testid="${testid}"]`;
      const tag = el.tagName.toLowerCase();
      const classes = Array.from(el.classList).slice(0, 3);
      return classes.length
        ? `${tag}.${classes.map(c => CSS.escape(c)).join('.')}`
        : tag;
    }

    function camelToKebab(s: string): string {
      return s.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);
    }

    function firstAnimatedProperty(
      anim: Animation
    ): string | undefined {
      try {
        const effect = anim.effect;
        if (!effect || typeof (effect as KeyframeEffect).getKeyframes !== 'function') {
          return undefined;
        }
        const frames = (effect as KeyframeEffect).getKeyframes();
        for (const frame of frames) {
          for (const key of Object.keys(frame)) {
            if (
              key === 'offset' ||
              key === 'computedOffset' ||
              key === 'easing' ||
              key === 'composite'
            ) {
              continue;
            }
            return camelToKebab(key);
          }
        }
      } catch {
        // ignore
      }
      return undefined;
    }

    function getDurationMs(anim: Animation): number {
      try {
        const effect = anim.effect;
        if (!effect || typeof effect.getTiming !== 'function') return 0;
        const timing = effect.getTiming();
        const d = timing.duration;
        if (typeof d === 'number' && isFinite(d)) return d;
        return 0;
      } catch {
        return 0;
      }
    }

    function getIterations(anim: Animation): number {
      try {
        const effect = anim.effect;
        if (!effect || typeof effect.getTiming !== 'function') return 1;
        const timing = effect.getTiming();
        const iter = timing.iterations;
        if (typeof iter !== 'number') return 1;
        if (!isFinite(iter)) return SENTINEL;
        return iter;
      } catch {
        return 1;
      }
    }

    function getAnimationName(anim: Animation): string | undefined {
      const named = anim as Animation & { animationName?: string };
      if (typeof named.animationName === 'string' && named.animationName) {
        return named.animationName;
      }
      const id = anim.id;
      return id ? id : undefined;
    }

    function getTargetEl(anim: Animation): Element | null {
      const effect = anim.effect as KeyframeEffect | null;
      if (!effect) return null;
      const target = effect.target;
      return target instanceof Element ? target : null;
    }

    function isCssAnimation(anim: Animation): boolean {
      const name = anim.constructor?.name ?? '';
      return name === 'CSSAnimation';
    }

    function isJsAnimation(anim: Animation): boolean {
      const name = anim.constructor?.name ?? '';
      return name === 'Animation';
    }

    function pseudoElementOf(anim: Animation): string | null {
      const effect = anim.effect as
        | (KeyframeEffect & { pseudoElement?: string | null })
        | null;
      if (!effect) return null;
      const pseudo = effect.pseudoElement;
      return typeof pseudo === 'string' ? pseudo : null;
    }

    const cssAnimations: Info[] = [];
    const jsAnimations: Info[] = [];
    const collected: Array<{ info: Info; composited: boolean }> = [];
    let infiniteCount = 0;

    const seen = new Set<Animation>();

    function collectFromElement(el: Element): void {
      const anyEl = el as Element & {
        getAnimations?: (opts?: { subtree?: boolean }) => Animation[];
      };
      if (typeof anyEl.getAnimations !== 'function') return;
      let anims: Animation[] = [];
      try {
        anims = anyEl.getAnimations({ subtree: false });
      } catch {
        return;
      }
      for (const anim of anims) {
        if (seen.has(anim)) continue;
        seen.add(anim);

        if (pseudoElementOf(anim) === '::marker') continue;

        const target = getTargetEl(anim) ?? el;
        const duration = getDurationMs(anim);
        const iterations = getIterations(anim);
        const animatedProperty = firstAnimatedProperty(anim);
        const name = getAnimationName(anim);

        const info: Info = {
          target: buildSelector(target),
          duration,
          iterations,
        };
        if (name !== undefined) info.name = name;
        if (animatedProperty !== undefined) info.animatedProperty = animatedProperty;

        if (iterations === SENTINEL) infiniteCount++;

        const composited = animatedProperty
          ? COMPOSITED.has(animatedProperty)
          : true;
        collected.push({ info, composited });

        if (isCssAnimation(anim)) {
          if (cssAnimations.length < LIMIT) cssAnimations.push(info);
        } else if (isJsAnimation(anim)) {
          if (jsAnimations.length < LIMIT) jsAnimations.push(info);
        }
      }
    }

    const all = document.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      collectFromElement(all[i]);
    }

    // Also walk shadow-less supplemental via getComputedStyle for elements
    // whose CSS animationName is set but weren't captured above (fallback).
    if (cssAnimations.length < LIMIT) {
      for (let i = 0; i < all.length && cssAnimations.length < LIMIT; i++) {
        const el = all[i];
        try {
          const cs = getComputedStyle(el);
          const animName = cs.animationName;
          if (!animName || animName === 'none') continue;
          const already = cssAnimations.some(a => a.target === buildSelector(el));
          if (already) continue;
          const durRaw = cs.animationDuration.split(',')[0]?.trim() ?? '';
          const iterRaw = cs.animationIterationCount.split(',')[0]?.trim() ?? '1';
          const durMs = /ms$/.test(durRaw)
            ? parseFloat(durRaw)
            : /s$/.test(durRaw)
              ? parseFloat(durRaw) * 1000
              : 0;
          const iter =
            iterRaw === 'infinite'
              ? SENTINEL
              : isFinite(parseFloat(iterRaw))
                ? parseFloat(iterRaw)
                : 1;
          if (iter === SENTINEL) infiniteCount++;
          const info: Info = {
            target: buildSelector(el),
            name: animName.split(',')[0]?.trim(),
            duration: isFinite(durMs) ? durMs : 0,
            iterations: iter,
          };
          cssAnimations.push(info);
          collected.push({ info, composited: true });
        } catch {
          // ignore
        }
      }
    }

    // Detect @media (prefers-reduced-motion: reduce) rules in stylesheets.
    let prefersReducedMotionHonored = false;

    function walkRules(rules: CSSRuleList | undefined): void {
      if (!rules) return;
      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i];
        if (rule instanceof CSSMediaRule) {
          const mediaText = (rule.conditionText || rule.media.mediaText || '').toLowerCase();
          if (mediaText.includes('prefers-reduced-motion')) {
            prefersReducedMotionHonored = true;
          }
          walkRules(rule.cssRules);
          continue;
        }
        const withRules = rule as CSSRule & { cssRules?: CSSRuleList };
        if (withRules.cssRules) {
          walkRules(withRules.cssRules);
        }
      }
    }

    for (const sheet of Array.from(document.styleSheets)) {
      try {
        walkRules(sheet.cssRules);
      } catch {
        // cross-origin stylesheet — cannot read cssRules
      }
    }

    const issues: Issue[] = [];

    if (infiniteCount > 0 && !prefersReducedMotionHonored) {
      issues.push({
        type: 'infinite-animation-no-reduced-motion-fallback',
        detail: `${infiniteCount} infinite animation(s) with no prefers-reduced-motion fallback`,
      });
    }

    for (const entry of collected) {
      if (entry.info.duration > LONG_MS) {
        issues.push({
          type: 'long-animation',
          target: entry.info.target,
          detail: `animation duration ${Math.round(entry.info.duration)}ms exceeds ${LONG_MS}ms`,
        });
      }
    }

    const seenNonComposited = new Set<string>();
    for (const entry of collected) {
      if (entry.composited) continue;
      const prop = entry.info.animatedProperty ?? 'unknown';
      const key = `${entry.info.target}::${prop}`;
      if (seenNonComposited.has(key)) continue;
      seenNonComposited.add(key);
      issues.push({
        type: 'non-composited-property',
        target: entry.info.target,
        detail: `animates non-composited property "${prop}" (triggers layout/paint)`,
      });
    }

    const total = cssAnimations.length + jsAnimations.length;
    if (total > MAX_TOTAL) {
      issues.push({
        type: 'too-many-animations',
        detail: `${total} concurrent animations exceed recommended max of ${MAX_TOTAL}`,
      });
    }

    return {
      cssAnimations,
      jsAnimations,
      infiniteAnimations: infiniteCount,
      prefersReducedMotionHonored,
      issues,
    };
  });

  const truncatedCss = scan.cssAnimations.slice(0, MAX_ENTRIES);
  const truncatedJs = scan.jsAnimations.slice(0, MAX_ENTRIES);

  return {
    page: url,
    cssAnimations: truncatedCss,
    jsAnimations: truncatedJs,
    infiniteAnimations: scan.infiniteAnimations,
    prefersReducedMotionHonored: scan.prefersReducedMotionHonored,
    issues: scan.issues,
    passed: scan.issues.length === 0,
  };
}
