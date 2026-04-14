import type { Page } from 'playwright';

export type MediaIssueType =
  | 'video-no-track'
  | 'audio-no-transcript'
  | 'autoplay-without-muted'
  | 'no-controls'
  | 'missing-accessible-name'
  | 'track-missing-srclang'
  | 'track-missing-label'
  | 'default-track-missing'
  | 'no-poster'
  | 'flashing-risk'
  | 'playsinline-missing-on-mobile'
  | 'audio-description-missing';

export interface MediaIssue {
  type: MediaIssueType;
  severity: 'info' | 'warn' | 'error';
  selector: string;
  detail: string;
  mediaType: 'video' | 'audio' | 'iframe';
}

export interface MediaAuditResult {
  page: string;
  videoCount: number;
  audioCount: number;
  iframeMediaCount: number;
  accessibleCount: number;
  issues: MediaIssue[];
  passed: boolean;
}

export async function auditMedia(page: Page): Promise<MediaAuditResult> {
  const url = page.url();

  const result = await page.evaluate(() => {
    type Sev = 'info' | 'warn' | 'error';
    type MT = 'video' | 'audio' | 'iframe';
    type IT =
      | 'video-no-track' | 'audio-no-transcript' | 'autoplay-without-muted'
      | 'no-controls' | 'missing-accessible-name' | 'track-missing-srclang'
      | 'track-missing-label' | 'default-track-missing' | 'no-poster'
      | 'flashing-risk' | 'playsinline-missing-on-mobile' | 'audio-description-missing';
    interface IL { type: IT; severity: Sev; selector: string; detail: string; mediaType: MT; }

    const issues: IL[] = [];
    let errorCount = 0;
    const push = (type: IT, severity: Sev, selector: string, detail: string, mediaType: MT): void => {
      issues.push({ type, severity, selector, detail, mediaType });
      if (severity === 'error') errorCount++;
    };

    const selectorPath = (el: Element): string => {
      const parts: string[] = [];
      let node: Element | null = el;
      let depth = 0;
      while (node && node.nodeType === 1 && depth < 6) {
        const cur: Element = node;
        const tag = cur.tagName.toLowerCase();
        const parent: Element | null = cur.parentElement;
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const sibs: Element[] = Array.from(parent.children).filter(
          (c: Element) => c.tagName === cur.tagName
        );
        const idx = sibs.indexOf(cur) + 1;
        parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
        node = parent;
        depth++;
      }
      return parts.join(' > ');
    };

    const hasScripted = (el: Element): boolean => {
      const p = el.parentElement;
      if (!p) return false;
      const r = p.getAttribute('role');
      if (r === 'region' || r === 'group' || r === 'application') return true;
      for (const sib of Array.from(p.children)) {
        if (sib === el) continue;
        const tag = sib.tagName.toLowerCase();
        if (tag === 'button' || tag === 'input') return true;
        const sr = sib.getAttribute('role');
        if (sr === 'button' || sr === 'slider' || sr === 'toolbar') return true;
        if (sib.querySelector('button, [role="button"], [role="slider"], [role="toolbar"]')) return true;
      }
      return false;
    };

    const transcriptRe = /transcript/i;
    const hasTranscript = (el: Element): boolean => {
      for (const attr of ['aria-describedby', 'aria-labelledby']) {
        const v = el.getAttribute(attr);
        if (!v) continue;
        for (const id of v.split(/\s+/).filter(Boolean)) {
          const t = document.getElementById(id);
          if (t && transcriptRe.test(t.textContent || '')) return true;
        }
      }
      const p = el.parentElement;
      if (p && transcriptRe.test(p.textContent || '')) return true;
      for (const dir of ['next', 'prev'] as const) {
        let s: Element | null = dir === 'next' ? el.nextElementSibling : el.previousElementSibling;
        let h = 0;
        while (s && h < 4) {
          if (transcriptRe.test(s.textContent || '')) return true;
          s = dir === 'next' ? s.nextElementSibling : s.previousElementSibling;
          h++;
        }
      }
      return false;
    };

    const isMobile = window.innerWidth <= 768;
    const videoEls = Array.from(document.querySelectorAll('video'));
    const audioEls = Array.from(document.querySelectorAll('audio'));
    const iframeEls = Array.from(document.querySelectorAll('iframe'));

    for (const v of videoEls) {
      const sel = selectorPath(v);
      const tracks = Array.from(v.querySelectorAll('track'));
      const captions = tracks.filter((t) => {
        const k = (t.getAttribute('kind') || '').toLowerCase();
        return k === 'captions' || k === 'subtitles';
      });
      if (captions.length === 0) {
        push('video-no-track', 'error', sel, 'video has no captions or subtitles track', 'video');
      }
      if (v.hasAttribute('autoplay') && !(v.hasAttribute('muted') || v.muted)) {
        push(
          'autoplay-without-muted',
          'error',
          sel,
          'autoplay video must be muted to comply with WCAG 1.4.2',
          'video'
        );
      }
      if (!v.hasAttribute('controls') && !hasScripted(v)) {
        push(
          'no-controls',
          'warn',
          sel,
          'video has no controls attribute and no scripted control siblings',
          'video'
        );
      }
      if (!v.hasAttribute('poster')) {
        push('no-poster', 'info', sel, 'video has no poster image', 'video');
      }
      if (isMobile && !v.hasAttribute('playsinline')) {
        push(
          'playsinline-missing-on-mobile',
          'info',
          sel,
          'video missing playsinline on mobile viewport',
          'video'
        );
      }
      for (const tr of tracks) {
        const ts = selectorPath(tr);
        if (!tr.getAttribute('srclang')) {
          push('track-missing-srclang', 'warn', ts, 'track element missing srclang attribute', 'video');
        }
        if (!tr.getAttribute('label')) {
          push('track-missing-label', 'warn', ts, 'track element missing label attribute', 'video');
        }
      }
      if (tracks.length > 0 && !tracks.some((t) => t.hasAttribute('default'))) {
        push(
          'default-track-missing',
          'info',
          sel,
          'multiple tracks present but none marked default',
          'video'
        );
      }
      if (
        tracks.length > 0 &&
        !tracks.some((t) => (t.getAttribute('kind') || '').toLowerCase() === 'descriptions')
      ) {
        push(
          'audio-description-missing',
          'info',
          sel,
          'video has tracks but no audio descriptions track',
          'video'
        );
      }
    }

    for (const a of audioEls) {
      const sel = selectorPath(a);
      if (!hasTranscript(a)) {
        push(
          'audio-no-transcript',
          'warn',
          sel,
          'audio element has no adjacent transcript link or region',
          'audio'
        );
      }
      if (a.hasAttribute('autoplay') && !(a.hasAttribute('muted') || a.muted)) {
        push(
          'autoplay-without-muted',
          'error',
          sel,
          'autoplay audio must be muted to comply with WCAG 1.4.2',
          'audio'
        );
      }
      if (!a.hasAttribute('controls') && !hasScripted(a)) {
        push(
          'no-controls',
          'warn',
          sel,
          'audio has no controls attribute and no scripted control siblings',
          'audio'
        );
      }
    }

    const platformRe = /youtube|vimeo|dailymotion|wistia|jwplatform|brightcove/;
    let iframeMediaCount = 0;
    for (const f of iframeEls) {
      const src = (f.getAttribute('src') || '').toLowerCase();
      if (!platformRe.test(src)) continue;
      iframeMediaCount++;
      const title = (f.getAttribute('title') || '').trim();
      if (!title) {
        push(
          'missing-accessible-name',
          'error',
          selectorPath(f),
          'video platform embed iframe missing title attribute',
          'iframe'
        );
      }
    }

    const flashRe = /\b(flashing|strobe|seizure)\b/i;
    const seen = new Set<Element>();
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const text = (el.textContent || '').slice(0, 500);
      if (!flashRe.test(text)) continue;
      let childHit = false;
      for (const c of Array.from(el.children)) {
        if (seen.has(c)) {
          childHit = true;
          break;
        }
      }
      if (childHit) continue;
      seen.add(el);
      const live = el.getAttribute('aria-live') === 'assertive';
      push(
        'flashing-risk',
        'warn',
        selectorPath(el),
        live
          ? 'aria-live region contains flashing/strobe/seizure keyword'
          : 'element text mentions flashing/strobe/seizure',
        'video'
      );
    }

    const videoCount = videoEls.length;
    const audioCount = audioEls.length;
    const accessibleCount = Math.max(0, videoCount + audioCount - errorCount);
    return { videoCount, audioCount, iframeMediaCount, accessibleCount, issues };
  });

  return {
    page: url,
    videoCount: result.videoCount,
    audioCount: result.audioCount,
    iframeMediaCount: result.iframeMediaCount,
    accessibleCount: result.accessibleCount,
    issues: result.issues,
    passed: result.issues.every((i) => i.severity !== 'error'),
  };
}
