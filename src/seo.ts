import type { Page } from 'playwright';

export interface SeoResult {
  page: string;
  title: string | null;
  description: string | null;
  canonical: string | null;
  og: Record<string, string>;
  twitter: Record<string, string>;
  robots: string | null;
  h1Count: number;
  imagesMissingAlt: number;
  lang: string | null;
  issues: string[];
  passed: boolean;
}

export async function checkSeo(page: Page): Promise<SeoResult> {
  const data = await page.evaluate(() => {
    const meta = (n: string) =>
      (document.querySelector(`meta[name="${n}"]`) as HTMLMetaElement | null)?.content ?? null;
    const ogAll: Record<string, string> = {};
    const twAll: Record<string, string> = {};
    document.querySelectorAll('meta[property^="og:"]').forEach((m: any) => {
      ogAll[m.getAttribute('property')] = m.getAttribute('content') ?? '';
    });
    document.querySelectorAll('meta[name^="twitter:"]').forEach((m: any) => {
      twAll[m.getAttribute('name')] = m.getAttribute('content') ?? '';
    });
    return {
      title: document.title || null,
      description: meta('description'),
      canonical: (document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null)?.href ?? null,
      og: ogAll,
      twitter: twAll,
      robots: meta('robots'),
      h1Count: document.querySelectorAll('h1').length,
      imagesMissingAlt: document.querySelectorAll('img:not([alt])').length,
      lang: document.documentElement.getAttribute('lang'),
    };
  });

  const issues: string[] = [];
  if (!data.title) issues.push('missing <title>');
  else if (data.title.length > 60) issues.push(`title too long (${data.title.length} chars, max 60)`);
  else if (data.title.length < 10) issues.push(`title too short (${data.title.length} chars, min 10)`);
  if (!data.description) issues.push('missing meta description');
  else if (data.description.length > 160) issues.push(`description too long (${data.description.length} chars)`);
  if (data.h1Count === 0) issues.push('no <h1> on page');
  if (data.h1Count > 1) issues.push(`multiple <h1> tags (${data.h1Count})`);
  if (!data.lang) issues.push('missing <html lang="…">');
  if (data.imagesMissingAlt > 0) issues.push(`${data.imagesMissingAlt} images missing alt attribute`);
  if (!data.og['og:title']) issues.push('missing og:title');
  if (!data.og['og:description']) issues.push('missing og:description');
  if (!data.og['og:image']) issues.push('missing og:image');
  if (!data.canonical) issues.push('missing canonical URL');

  return { page: page.url(), ...data, issues, passed: issues.length === 0 };
}
