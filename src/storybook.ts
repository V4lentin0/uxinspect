import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { applyMaskToPng, resolveMaskRegions, type MaskRegion } from './visual-mask.js';

export interface StoryEntry {
  id: string;
  title: string;
  name: string;
  kind: string;
}

export interface StoryShot {
  id: string;
  url: string;
  title: string;
  name: string;
  screenshotPath: string;
  width: number;
  height: number;
  passed: boolean;
  error?: string;
}

export interface StorybookViewport {
  width: number;
  height: number;
  name?: string;
}

export interface StorybookRunResult {
  baseUrl: string;
  totalStories: number;
  capturedCount: number;
  skippedCount: number;
  shots: StoryShot[];
  indexFile: string;
  passed: boolean;
}

interface IndexJsonShape {
  entries?: Record<string, Record<string, unknown>>;
  stories?: Record<string, Record<string, unknown>>;
}

const DEFAULT_MAX_STORIES = 500;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_VIEWPORT: StorybookViewport = { width: 1280, height: 800 };
const SETTLE_DELAY_MS = 200;
const ROOT_SELECTORS = ['#storybook-root', '#root'];

function trimSlash(input: string): string {
  return input.endsWith('/') ? input.slice(0, -1) : input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asStr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

async function fetchJson(url: string): Promise<IndexJsonShape | null> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const json: unknown = await res.json();
    return isRecord(json) ? (json as IndexJsonShape) : null;
  } catch {
    return null;
  }
}

function parseEntries(raw: IndexJsonShape): StoryEntry[] {
  const map = raw.entries ?? raw.stories ?? {};
  const out: StoryEntry[] = [];
  for (const [key, value] of Object.entries(map)) {
    if (!isRecord(value)) continue;
    const type = typeof value.type === 'string' ? value.type : 'story';
    if (type === 'docs') continue;
    const id = asStr(value.id, key);
    const title = asStr(value.title, '');
    if (!id) continue;
    out.push({ id, title, name: asStr(value.name, ''), kind: asStr(value.kind, title) });
  }
  return out;
}

export async function listStories(baseUrl: string): Promise<StoryEntry[]> {
  const base = trimSlash(baseUrl);
  for (const url of [`${base}/index.json`, `${base}/stories.json`]) {
    const data = await fetchJson(url);
    if (data) {
      const entries = parseEntries(data);
      if (entries.length > 0) return entries;
    }
  }
  throw new Error(`unable to load story catalog index from ${base}`);
}

function compileMatchers(input: (RegExp | string)[] | undefined): RegExp[] {
  if (!input) return [];
  return input.map((m) => (m instanceof RegExp ? m : new RegExp(m)));
}

function matchesAny(matchers: RegExp[], story: StoryEntry): boolean {
  for (const re of matchers) {
    if (re.test(story.id) || re.test(story.title)) return true;
  }
  return false;
}

function filterStories(
  stories: StoryEntry[],
  include: (RegExp | string)[] | undefined,
  exclude: (RegExp | string)[] | undefined,
): StoryEntry[] {
  const inc = compileMatchers(include);
  const exc = compileMatchers(exclude);
  return stories.filter((s) => {
    if (inc.length > 0 && !matchesAny(inc, s)) return false;
    if (exc.length > 0 && matchesAny(exc, s)) return false;
    return true;
  });
}

function safeId(id: string): string {
  return id.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 200);
}

function viewportFolder(vp: StorybookViewport): string {
  return vp.name ?? `${vp.width}x${vp.height}`;
}

function storyUrl(base: string, id: string): string {
  return `${base}/iframe.html?id=${encodeURIComponent(id)}&viewMode=story`;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

async function waitForRoot(page: Page, customSelector: string | undefined): Promise<void> {
  if (customSelector) {
    await page.waitForSelector(customSelector, { timeout: 15000 });
    return;
  }
  for (const selector of ROOT_SELECTORS) {
    try {
      await page.waitForSelector(selector, { timeout: 5000 });
      return;
    } catch {
      // try next root selector
    }
  }
}

interface CaptureArgs {
  context: BrowserContext;
  story: StoryEntry;
  baseUrl: string;
  viewport: StorybookViewport;
  outDir: string;
  fullPage: boolean;
  waitForSelector: string | undefined;
  maskRegions: MaskRegion[] | undefined;
}

async function captureOne(args: CaptureArgs): Promise<StoryShot> {
  const { context, story, baseUrl, viewport, outDir, fullPage, waitForSelector, maskRegions } = args;
  const url = storyUrl(baseUrl, story.id);
  const folder = path.join(outDir, viewportFolder(viewport));
  const screenshotPath = path.join(folder, `${safeId(story.id)}.png`);
  const shot: StoryShot = {
    id: story.id, url, title: story.title, name: story.name,
    screenshotPath, width: viewport.width, height: viewport.height, passed: false,
  };
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await waitForRoot(page, waitForSelector);
    await delay(SETTLE_DELAY_MS);
    await fs.mkdir(folder, { recursive: true });
    let buffer = await page.screenshot({ fullPage });
    if (maskRegions && maskRegions.length > 0) {
      const rects = await resolveMaskRegions(page, maskRegions);
      buffer = applyMaskToPng(buffer, rects);
    }
    await fs.writeFile(screenshotPath, buffer);
    shot.passed = true;
  } catch (err) {
    shot.error = err instanceof Error ? err.message : String(err);
  } finally {
    await page.close().catch(() => {});
  }
  return shot;
}

async function runPool<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  const workers: Promise<void>[] = [];
  for (let i = 0; i < lanes; i += 1) {
    workers.push((async () => {
      while (true) {
        const idx = cursor;
        cursor += 1;
        if (idx >= items.length) return;
        const item = items[idx];
        if (item === undefined) return;
        results[idx] = await worker(item);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

export async function captureStorybook(opts: {
  baseUrl: string;
  context: BrowserContext;
  outDir: string;
  include?: (RegExp | string)[];
  exclude?: (RegExp | string)[];
  viewports?: StorybookViewport[];
  maxStories?: number;
  fullPage?: boolean;
  waitForSelector?: string;
  maskRegions?: MaskRegion[];
  concurrency?: number;
}): Promise<StorybookRunResult> {
  const baseUrl = trimSlash(opts.baseUrl);
  const indexFile = `${baseUrl}/index.json`;
  const allStories = await listStories(baseUrl);
  const filtered = filterStories(allStories, opts.include, opts.exclude);
  const cap = opts.maxStories ?? DEFAULT_MAX_STORIES;
  const selected = filtered.slice(0, Math.max(0, cap));
  const viewports = opts.viewports && opts.viewports.length > 0 ? opts.viewports : [DEFAULT_VIEWPORT];
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const fullPage = opts.fullPage ?? false;

  await fs.mkdir(opts.outDir, { recursive: true });

  type Job = { story: StoryEntry; viewport: StorybookViewport };
  const jobs: Job[] = [];
  for (const viewport of viewports) {
    for (const story of selected) jobs.push({ story, viewport });
  }

  const shots = await runPool(jobs, concurrency, (job) => captureOne({
    context: opts.context, story: job.story, baseUrl, viewport: job.viewport,
    outDir: opts.outDir, fullPage, waitForSelector: opts.waitForSelector, maskRegions: opts.maskRegions,
  }));

  const capturedCount = shots.filter((s) => s.passed).length;
  const skippedCount = Math.max(0, filtered.length - selected.length);
  const passed = shots.length > 0 && shots.every((s) => s.passed) && capturedCount > 0;

  return {
    baseUrl, totalStories: allStories.length, capturedCount, skippedCount,
    shots, indexFile, passed,
  };
}
