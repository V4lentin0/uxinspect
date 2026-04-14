import type { Page } from 'playwright';

export interface PassiveSecurityIssue {
  level: 'error' | 'warn';
  type:
    | 'sri-missing'
    | 'mixed-content'
    | 'cookie-not-secure'
    | 'cookie-not-httponly'
    | 'cookie-no-samesite'
    | 'target-blank-no-noopener'
    | 'form-action-http'
    | 'password-on-http';
  selector?: string;
  url?: string;
  cookieName?: string;
  message: string;
}

export interface PassiveSecurityResult {
  page: string;
  issues: PassiveSecurityIssue[];
  scannedScripts: number;
  scannedLinks: number;
  cookiesChecked: number;
  passed: boolean;
}

interface DomSnapshot {
  pageProtocol: string;
  scripts: Array<{ src: string; integrity: string | null; crossorigin: string | null; selector: string }>;
  stylesheets: Array<{ href: string; integrity: string | null; crossorigin: string | null; selector: string }>;
  mixed: Array<{ url: string; selector: string; tag: string }>;
  formsHttp: Array<{ action: string; selector: string }>;
  passwords: Array<{ selector: string }>;
  blankLinks: Array<{ href: string; rel: string; selector: string }>;
}

export async function auditPassiveSecurity(page: Page): Promise<PassiveSecurityResult> {
  const pageUrl = page.url();
  let pageHost = '';
  let pageProtocol = 'about:';
  try {
    const u = new URL(pageUrl);
    pageHost = u.hostname;
    pageProtocol = u.protocol;
  } catch {}
  const isHttps = pageProtocol === 'https:';

  const snapshot = await page.evaluate((): DomSnapshot => {
    const cssPath = (el: Element): string => {
      if (el.id) return `#${el.id}`;
      const parts: string[] = [];
      let node: Element | null = el;
      let depth = 0;
      while (node && depth < 4) {
        const name: string = node.nodeName.toLowerCase();
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

    const scripts = Array.from(document.querySelectorAll('script[src]')).map((s) => ({
      src: (s as HTMLScriptElement).src,
      integrity: s.getAttribute('integrity'),
      crossorigin: s.getAttribute('crossorigin'),
      selector: cssPath(s),
    }));

    const stylesheets = Array.from(document.querySelectorAll('link[rel~="stylesheet"][href]')).map((l) => ({
      href: (l as HTMLLinkElement).href,
      integrity: l.getAttribute('integrity'),
      crossorigin: l.getAttribute('crossorigin'),
      selector: cssPath(l),
    }));

    const mixed: Array<{ url: string; selector: string; tag: string }> = [];
    for (const sel of ['script[src]', 'img[src]', 'iframe[src]', 'source[src]', 'video[src]', 'audio[src]', 'embed[src]', 'link[href]']) {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        const raw = el.getAttribute(el.hasAttribute('src') ? 'src' : 'href') || '';
        if (raw.toLowerCase().startsWith('http://')) {
          mixed.push({ url: raw, selector: cssPath(el), tag: el.nodeName.toLowerCase() });
        }
      }
    }

    const formsHttp = Array.from(document.querySelectorAll('form[action]'))
      .filter((f) => (f.getAttribute('action') || '').toLowerCase().startsWith('http://'))
      .map((f) => ({ action: f.getAttribute('action') || '', selector: cssPath(f) }));

    const passwords = Array.from(document.querySelectorAll('input[type="password"]')).map((i) => ({ selector: cssPath(i) }));

    const blankLinks = Array.from(document.querySelectorAll('a[target="_blank"]')).map((a) => ({
      href: (a as HTMLAnchorElement).href,
      rel: (a.getAttribute('rel') || '').toLowerCase(),
      selector: cssPath(a),
    }));

    return { pageProtocol: location.protocol, scripts, stylesheets, mixed, formsHttp, passwords, blankLinks };
  });

  const issues: PassiveSecurityIssue[] = [];

  const isCrossOrigin = (resourceUrl: string): boolean => {
    try {
      const u = new URL(resourceUrl, pageUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      return u.hostname !== pageHost;
    } catch { return false; }
  };

  for (const s of snapshot.scripts) {
    if (isCrossOrigin(s.src) && (!s.integrity || !s.crossorigin)) {
      issues.push({
        level: 'warn', type: 'sri-missing', selector: s.selector, url: s.src,
        message: `cross-origin script missing ${!s.integrity ? 'integrity' : 'crossorigin'} attribute`,
      });
    }
  }
  for (const l of snapshot.stylesheets) {
    if (isCrossOrigin(l.href) && (!l.integrity || !l.crossorigin)) {
      issues.push({
        level: 'warn', type: 'sri-missing', selector: l.selector, url: l.href,
        message: `cross-origin stylesheet missing ${!l.integrity ? 'integrity' : 'crossorigin'} attribute`,
      });
    }
  }

  if (isHttps) {
    for (const m of snapshot.mixed) {
      issues.push({
        level: 'error', type: 'mixed-content', selector: m.selector, url: m.url,
        message: `mixed content: <${m.tag}> loads http:// resource on https page`,
      });
    }
    for (const f of snapshot.formsHttp) {
      issues.push({
        level: 'error', type: 'form-action-http', selector: f.selector, url: f.action,
        message: 'form posts to http:// from https page',
      });
    }
  }

  if (snapshot.pageProtocol === 'http:') {
    for (const p of snapshot.passwords) {
      issues.push({ level: 'error', type: 'password-on-http', selector: p.selector, message: 'password input served over http://' });
    }
  }

  for (const a of snapshot.blankLinks) {
    const hasNoopener = /(^|\s)noopener(\s|$)/.test(a.rel);
    const hasNoreferrer = /(^|\s)noreferrer(\s|$)/.test(a.rel);
    if (!hasNoopener && !hasNoreferrer) {
      issues.push({
        level: 'warn', type: 'target-blank-no-noopener', selector: a.selector, url: a.href,
        message: 'target="_blank" without rel="noopener" enables reverse tabnabbing',
      });
    }
  }

  const cookies = await page.context().cookies();
  for (const c of cookies) {
    if (c.secure === false) {
      issues.push({
        level: isHttps ? 'error' : 'warn', type: 'cookie-not-secure', cookieName: c.name,
        message: `cookie "${c.name}" missing Secure flag`,
      });
    }
    if (c.httpOnly === false) {
      issues.push({ level: 'warn', type: 'cookie-not-httponly', cookieName: c.name, message: `cookie "${c.name}" missing HttpOnly flag` });
    }
    const ss = (c as { sameSite?: string }).sameSite;
    if (!ss || ss === '') {
      issues.push({ level: 'warn', type: 'cookie-no-samesite', cookieName: c.name, message: `cookie "${c.name}" missing SameSite attribute` });
    }
  }

  return {
    page: pageUrl,
    issues,
    scannedScripts: snapshot.scripts.length,
    scannedLinks: snapshot.stylesheets.length,
    cookiesChecked: cookies.length,
    passed: !issues.some((i) => i.level === 'error'),
  };
}
