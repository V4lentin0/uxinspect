import type { Page } from 'playwright';

export interface ReadabilityMetrics {
  totalWords: number;
  totalSentences: number;
  totalSyllables: number;
  avgWordsPerSentence: number;
  avgSyllablesPerWord: number;
  percentDifficultWords: number;
}

export interface ReadabilityScores {
  fleschReadingEase: number;
  fleschKincaidGrade: number;
  gunningFog: number;
  smog: number;
  automatedReadabilityIndex: number;
  colemanLiau: number;
  linsearWrite: number;
}

export interface ReadabilityIssue {
  type: 'too-complex' | 'too-long-sentence' | 'passive-overuse' | 'no-main-content' | 'short-content';
  severity: 'info' | 'warn';
  detail: string;
}

export interface ReadingLevelResult {
  page: string;
  lang: string;
  metrics: ReadabilityMetrics;
  scores: ReadabilityScores;
  issues: ReadabilityIssue[];
  readingLevel: 'easy' | 'fairly-easy' | 'standard' | 'fairly-difficult' | 'difficult' | 'very-difficult';
  passed: boolean;
}

interface ExtractedContent {
  text: string;
  found: boolean;
  selector: string;
}

const COMMON_SUFFIXES = /(?:es|ed|ing|ly)$/;

function syllables(word: string): number {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
  w = w.replace(/^y/, '');
  const m = w.match(/[aeiouy]{1,2}/g);
  return m ? m.length : 1;
}

function isProperNoun(word: string, position: number): boolean {
  if (position === 0) return false;
  return /^[A-Z][a-z]+/.test(word);
}

function splitSentences(text: string): string[] {
  return text
    .split(/[.!?]+(?:\s+|$)/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function extractWords(text: string): string[] {
  return text.split(/\s+/).filter(w => /[a-zA-Z]/.test(w));
}

function countLetters(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (/[a-zA-Z]/.test(ch)) n++;
  }
  return n;
}

function isComplexWord(word: string): boolean {
  const clean = word.replace(/[^a-zA-Z]/g, '');
  if (clean.length === 0) return false;
  if (syllables(clean) < 3) return false;
  if (COMMON_SUFFIXES.test(clean.toLowerCase())) {
    const stripped = clean.toLowerCase().replace(COMMON_SUFFIXES, '');
    if (syllables(stripped) < 3) return false;
  }
  return true;
}

function linsearWriteScore(text: string): number {
  const words = extractWords(text).slice(0, 100);
  if (words.length === 0) return 0;
  const sample = words.join(' ');
  const sentenceCount = Math.max(splitSentences(sample).length, 1);
  let easy = 0;
  let hard = 0;
  for (const w of words) {
    const clean = w.replace(/[^a-zA-Z]/g, '');
    if (clean.length === 0) continue;
    if (syllables(clean) >= 3) hard++;
    else easy++;
  }
  const r = (easy * 1 + hard * 3) / sentenceCount;
  return r > 20 ? r / 2 : (r - 2) / 2;
}

function bucketReadingLevel(ease: number): ReadingLevelResult['readingLevel'] {
  if (ease >= 90) return 'easy';
  if (ease >= 80) return 'fairly-easy';
  if (ease >= 70) return 'standard';
  if (ease >= 60) return 'fairly-difficult';
  if (ease >= 50) return 'difficult';
  return 'very-difficult';
}

function round1(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}

async function extractMainText(page: Page, mainSelector?: string): Promise<ExtractedContent> {
  return page.evaluate((sel: string | null) => {
    const candidates: string[] = [];
    if (sel) candidates.push(sel);
    candidates.push('main', 'article', '[role="main"]', 'body');
    for (const candidate of candidates) {
      const el = document.querySelector(candidate) as HTMLElement | null;
      if (el && (el.innerText ?? '').trim().length > 0) {
        const text = (el.innerText ?? '').replace(/\s+/g, ' ').trim();
        return { text, found: candidate !== 'body', selector: candidate };
      }
    }
    return { text: '', found: false, selector: 'body' };
  }, mainSelector ?? null);
}

export async function auditReadingLevel(
  page: Page,
  opts?: { maxGrade?: number; mainSelector?: string },
): Promise<ReadingLevelResult> {
  const url = page.url();
  const maxGrade = opts?.maxGrade ?? 12;

  const lang = await page.evaluate(() => document.documentElement.lang || 'und');
  const extracted = await extractMainText(page, opts?.mainSelector);
  const text = extracted.text;

  const issues: ReadabilityIssue[] = [];

  if (!extracted.found) {
    issues.push({
      type: 'no-main-content',
      severity: 'warn',
      detail: 'No <main>, <article>, or [role="main"] element found; falling back to body',
    });
  }

  const sentencesArr = splitSentences(text);
  const wordsArr = extractWords(text);
  const totalWords = wordsArr.length;
  const totalSentences = Math.max(sentencesArr.length, 1);

  let totalSyllables = 0;
  let complexCount = 0;
  for (let i = 0; i < wordsArr.length; i++) {
    const w = wordsArr[i];
    const clean = w.replace(/[^a-zA-Z]/g, '');
    if (clean.length === 0) continue;
    totalSyllables += syllables(clean);
    if (!isProperNoun(w, i) && isComplexWord(w)) complexCount++;
  }

  const wordsSafe = totalWords === 0 ? 1 : totalWords;
  const avgWordsPerSentence = totalWords / totalSentences;
  const avgSyllablesPerWord = totalSyllables / wordsSafe;
  const percentDifficultWords = (complexCount / wordsSafe) * 100;
  const charCount = countLetters(text);

  const fleschReadingEase = 206.835 - 1.015 * avgWordsPerSentence - 84.6 * avgSyllablesPerWord;
  const fleschKincaidGrade = 0.39 * avgWordsPerSentence + 11.8 * avgSyllablesPerWord - 15.59;
  const gunningFog = 0.4 * (avgWordsPerSentence + 100 * (complexCount / wordsSafe));
  const smog = 1.043 * Math.sqrt(30 * (complexCount / totalSentences)) + 3.1291;
  const automatedReadabilityIndex = 4.71 * (charCount / wordsSafe) + 0.5 * avgWordsPerSentence - 21.43;
  const lettersPer100 = (charCount / wordsSafe) * 100;
  const sentencesPer100 = (totalSentences / wordsSafe) * 100;
  const colemanLiau = 0.0588 * lettersPer100 - 0.296 * sentencesPer100 - 15.8;
  const linsearWrite = linsearWriteScore(text);

  const scores: ReadabilityScores = {
    fleschReadingEase: round1(fleschReadingEase),
    fleschKincaidGrade: round1(fleschKincaidGrade),
    gunningFog: round1(gunningFog),
    smog: round1(smog),
    automatedReadabilityIndex: round1(automatedReadabilityIndex),
    colemanLiau: round1(colemanLiau),
    linsearWrite: round1(linsearWrite),
  };

  const metrics: ReadabilityMetrics = {
    totalWords,
    totalSentences: sentencesArr.length,
    totalSyllables,
    avgWordsPerSentence: round1(avgWordsPerSentence),
    avgSyllablesPerWord: round1(avgSyllablesPerWord),
    percentDifficultWords: round1(percentDifficultWords),
  };

  if (totalWords > 0 && scores.fleschKincaidGrade > maxGrade) {
    issues.push({
      type: 'too-complex',
      severity: 'warn',
      detail: `Flesch-Kincaid grade ${scores.fleschKincaidGrade} exceeds max ${maxGrade}`,
    });
  }

  let longSentences = 0;
  for (const s of sentencesArr) {
    const wc = extractWords(s).length;
    if (wc > 30) longSentences++;
  }
  if (longSentences > 0) {
    issues.push({
      type: 'too-long-sentence',
      severity: 'info',
      detail: `${longSentences} sentence(s) exceed 30 words`,
    });
  }

  const passiveMatches = text.match(/\b(is|are|was|were|be|been|being)\s+\w+ed\b/g) ?? [];
  const passiveRatio = passiveMatches.length / totalSentences;
  if (passiveRatio > 0.25) {
    issues.push({
      type: 'passive-overuse',
      severity: 'info',
      detail: `Passive voice ratio ${round1(passiveRatio * 100)}% (${passiveMatches.length}/${totalSentences})`,
    });
  }

  if (totalWords > 0 && totalWords < 100) {
    issues.push({
      type: 'short-content',
      severity: 'info',
      detail: `Only ${totalWords} words; readability scores are unreliable`,
    });
  }

  const primaryLang = lang.toLowerCase().split('-')[0] ?? '';
  if (primaryLang && primaryLang !== 'en' && primaryLang !== 'und') {
    issues.push({
      type: 'short-content',
      severity: 'info',
      detail: `Page lang="${lang}"; scores are calibrated for English`,
    });
  }

  const readingLevel = bucketReadingLevel(scores.fleschReadingEase);
  const passed = issues.every(i => {
    if (i.severity !== 'warn') return true;
    return i.type !== 'too-complex' && i.type !== 'no-main-content';
  });

  return {
    page: url,
    lang,
    metrics,
    scores,
    issues,
    readingLevel,
    passed,
  };
}
