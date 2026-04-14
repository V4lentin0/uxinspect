import type { Page } from 'playwright';

export interface LinkCheckResult {
  page: string;
  total: number;
  broken: { url: string; status: number; text?: string }[];
  issues: string[];
  passed: boolean;
}

export interface LinkCheckOptions {
  maxLinks?: number;
  sameOriginOnly?: boolean;
  timeoutMs?: number;
}

export async function checkLinks(page: Page, opts: LinkCheckOptions = {}): Promise<LinkCheckResult> {
  const origin = new URL(page.url()).origin;
  const limit = opts.maxLinks ?? 100;
  const timeout = opts.timeoutMs ?? 8000;

  const links = await page.evaluate(() => {
    const out: { href: string; text: string }[] = [];
    document.querySelectorAll('a[href]').forEach((a: any) => {
      const href = a.href as string;
      if (!href || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
      out.push({ href, text: (a.textContent ?? '').trim().slice(0, 60) });
    });
    return out;
  });

  const unique = Array.from(new Map(links.map((l) => [l.href, l])).values()).slice(0, limit);
  const filtered = opts.sameOriginOnly
    ? unique.filter((l) => {
        try {
          return new URL(l.href).origin === origin;
        } catch {
          return false;
        }
      })
    : unique;

  const broken: LinkCheckResult['broken'] = [];
  const controller = new AbortController();
  await Promise.all(
    filtered.map(async (l) => {
      try {
        const t = setTimeout(() => controller.abort(), timeout);
        const r = await fetch(l.href, { method: 'HEAD', redirect: 'follow', signal: controller.signal }).catch(
          () => fetch(l.href, { method: 'GET', redirect: 'follow', signal: controller.signal }),
        );
        clearTimeout(t);
        if (r.status >= 400) broken.push({ url: l.href, status: r.status, text: l.text });
      } catch {
        broken.push({ url: l.href, status: 0, text: l.text });
      }
    }),
  );

  const issues = broken.map((b) => `${b.status || 'ERR'} ${b.url}`);
  return {
    page: page.url(),
    total: filtered.length,
    broken,
    issues,
    passed: broken.length === 0,
  };
}
