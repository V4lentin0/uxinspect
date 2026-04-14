import type { Page } from 'playwright';

export interface PwaResult {
  page: string;
  manifest: { url: string; valid: boolean; errors: string[] } | null;
  serviceWorker: boolean;
  installable: boolean;
  offlineReady: boolean;
  issues: string[];
  passed: boolean;
}

export async function checkPwa(page: Page): Promise<PwaResult> {
  const manifestInfo = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]') as HTMLLinkElement | null;
    if (!link?.href) return null;
    try {
      const res = await fetch(link.href);
      if (!res.ok) return { url: link.href, json: null, status: res.status };
      const json = await res.json();
      return { url: link.href, json, status: 200 };
    } catch (e) {
      return { url: link.href, json: null, status: 0 };
    }
  });

  const serviceWorker = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const regs = await (navigator as any).serviceWorker.getRegistrations().catch(() => []);
    return regs.length > 0;
  });

  const issues: string[] = [];
  let manifest: PwaResult['manifest'] = null;
  let installable = false;

  if (!manifestInfo) {
    issues.push('no <link rel="manifest">');
  } else if (!manifestInfo.json) {
    issues.push(`manifest not loadable (${manifestInfo.status})`);
    manifest = { url: manifestInfo.url, valid: false, errors: [`HTTP ${manifestInfo.status}`] };
  } else {
    const m = manifestInfo.json as any;
    const errs: string[] = [];
    if (!m.name && !m.short_name) errs.push('name or short_name required');
    if (!m.start_url) errs.push('start_url required');
    if (!m.display) errs.push('display required');
    if (!Array.isArray(m.icons) || m.icons.length === 0) errs.push('icons[] required');
    if (Array.isArray(m.icons) && !m.icons.some((i: any) => /512/.test(i.sizes ?? ''))) errs.push('512x512 icon recommended');
    manifest = { url: manifestInfo.url, valid: errs.length === 0, errors: errs };
    installable = errs.length === 0 && serviceWorker;
    if (errs.length) issues.push(...errs.map((e) => `manifest: ${e}`));
  }

  if (!serviceWorker) issues.push('no service worker registered');

  return {
    page: page.url(),
    manifest,
    serviceWorker,
    installable,
    offlineReady: serviceWorker && (manifest?.valid ?? false),
    issues,
    passed: issues.length === 0,
  };
}
