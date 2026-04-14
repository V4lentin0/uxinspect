import type { Page } from 'playwright';

export interface ContentQualityOptions {
  minWords?: number;
  dupThreshold?: number;
}

export interface PageContentInfo {
  url: string;
  title: string;
  metaDescription: string;
  h1Count: number;
  wordCount: number;
  fleschReadingEase: number;
  fleschKincaidGrade: number;
  textSample: string;
}

export interface DuplicateGroup {
  kind: 'title' | 'meta' | 'body';
  urls: string[];
  similarity: number;
}

export interface ContentQualityResult {
  pages: PageContentInfo[];
  thinContent: string[];
  duplicates: DuplicateGroup[];
  issues: { level: 'error' | 'warn'; message: string; url?: string }[];
  passed: boolean;
}

export async function analyzePage(page: Page, opts?: ContentQualityOptions): Promise<PageContentInfo> {
  return page.evaluate(() => {
    const title = document.title;
    const meta = document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
    const h1Count = document.querySelectorAll('h1').length;
    const text = (document.body.innerText ?? '').replace(/\s+/g, ' ').trim();

    const wordList = text.split(/\s+/).filter(Boolean);
    const words = wordList.length;
    const sentenceList = text.split(/[.!?]+/).filter(Boolean);
    const sentences = Math.max(sentenceList.length, 1);

    let syllables = 0;
    for (const w of wordList) {
      const matches = w.match(/[aeiouy]+/gi);
      syllables += matches ? Math.max(matches.length, 1) : 1;
    }

    const wordsOrOne = words === 0 ? 1 : words;
    const fleschReadingEase = words === 0
      ? 0
      : Math.round((206.835 - 1.015 * (words / sentences) - 84.6 * (syllables / wordsOrOne)) * 10) / 10;
    const fleschKincaidGrade = words === 0
      ? 0
      : Math.round((0.39 * (words / sentences) + 11.8 * (syllables / wordsOrOne) - 15.59) * 10) / 10;

    return {
      url: location.href,
      title,
      metaDescription: meta,
      h1Count,
      wordCount: words,
      fleschReadingEase,
      fleschKincaidGrade,
      textSample: text.slice(0, 500),
    };
  });
}

function make4Grams(sample: string): Set<string> {
  const tokens = sample.split(/\s+/).filter(Boolean);
  const grams = new Set<string>();
  for (let i = 0; i <= tokens.length - 4; i++) {
    grams.add(tokens.slice(i, i + 4).join('|'));
  }
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const g of a) {
    if (b.has(g)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function analyzeBatch(infos: PageContentInfo[], opts?: ContentQualityOptions): ContentQualityResult {
  const minWords = opts?.minWords ?? 300;
  const dupThreshold = opts?.dupThreshold ?? 0.9;

  const thinContent: string[] = [];
  const duplicates: DuplicateGroup[] = [];
  const issues: { level: 'error' | 'warn'; message: string; url?: string }[] = [];

  // Thin content
  for (const p of infos) {
    if (p.wordCount < minWords) {
      thinContent.push(p.url);
      issues.push({ level: 'warn', message: `Thin content: ${p.wordCount} words (min ${minWords})`, url: p.url });
    }
  }

  // H1 check
  for (const p of infos) {
    if (p.h1Count !== 1) {
      issues.push({ level: 'warn', message: `H1 count is ${p.h1Count} (expected 1)`, url: p.url });
    }
  }

  // Title duplicates
  const titleMap = new Map<string, string[]>();
  for (const p of infos) {
    const key = p.title.trim().toLowerCase();
    if (!key) continue;
    const group = titleMap.get(key) ?? [];
    group.push(p.url);
    titleMap.set(key, group);
  }
  for (const [, urls] of titleMap) {
    if (urls.length > 1) {
      duplicates.push({ kind: 'title', urls, similarity: 1 });
      issues.push({ level: 'warn', message: `Duplicate title across ${urls.length} pages: ${urls.join(', ')}` });
    }
  }

  // Meta description duplicates
  const metaMap = new Map<string, string[]>();
  for (const p of infos) {
    const key = p.metaDescription.trim().toLowerCase();
    if (!key) continue;
    const group = metaMap.get(key) ?? [];
    group.push(p.url);
    metaMap.set(key, group);
  }
  for (const [, urls] of metaMap) {
    if (urls.length > 1) {
      duplicates.push({ kind: 'meta', urls, similarity: 1 });
      issues.push({ level: 'warn', message: `Duplicate meta description across ${urls.length} pages: ${urls.join(', ')}` });
    }
  }

  // Body 4-gram Jaccard duplicates
  const grams = infos.map(p => make4Grams(p.textSample));
  const bodyPairs: DuplicateGroup[] = [];
  for (let i = 0; i < infos.length; i++) {
    for (let j = i + 1; j < infos.length; j++) {
      const sim = jaccard(grams[i], grams[j]);
      if (sim >= dupThreshold) {
        bodyPairs.push({ kind: 'body', urls: [infos[i].url, infos[j].url], similarity: sim });
        issues.push({
          level: 'warn',
          message: `Near-duplicate body content (similarity ${sim.toFixed(2)}): ${infos[i].url} vs ${infos[j].url}`,
        });
      }
    }
  }
  duplicates.push(...bodyPairs);

  const passed = !issues.some(i => i.level === 'error');

  return { pages: infos, thinContent, duplicates, issues, passed };
}
