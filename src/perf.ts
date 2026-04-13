import type { PerfResult } from './types.js';

export async function checkPerf(url: string, port: number): Promise<PerfResult> {
  const lighthouse = (await import('lighthouse')).default;
  const result = await lighthouse(url, {
    port,
    output: 'json',
    logLevel: 'error',
    onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
  });
  if (!result) throw new Error(`Perf audit returned no result for ${url}`);
  const lhr = result.lhr;
  const score = (id: string) => Math.round(((lhr.categories[id]?.score ?? 0) as number) * 100);
  const metric = (id: string) => (lhr.audits[id]?.numericValue ?? 0) as number;
  return {
    page: url,
    scores: {
      performance: score('performance'),
      accessibility: score('accessibility'),
      bestPractices: score('best-practices'),
      seo: score('seo'),
    },
    metrics: {
      lcp: metric('largest-contentful-paint'),
      fcp: metric('first-contentful-paint'),
      cls: metric('cumulative-layout-shift'),
      tbt: metric('total-blocking-time'),
      si: metric('speed-index'),
    },
  };
}
