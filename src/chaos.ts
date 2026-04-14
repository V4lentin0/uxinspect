import type { Page, ElementHandle, ConsoleMessage, Request } from 'playwright';

export type ChaosAction = 'click' | 'type' | 'scroll' | 'key' | 'hover' | 'resize';

export interface ChaosEvent {
  action: ChaosAction;
  target?: string;
  value?: string;
  timestamp: number;
  error?: string;
}

export interface ChaosError {
  kind: 'console' | 'pageerror' | 'requestfailed' | 'unhandled-rejection';
  message: string;
  url?: string;
  atEventIndex: number;
}

export interface ChaosResult {
  page: string;
  totalActions: number;
  actionsByKind: Record<ChaosAction, number>;
  events: ChaosEvent[];
  errors: ChaosError[];
  durationMs: number;
  finalUrl: string;
  crashed: boolean;
  passed: boolean;
}

export interface ChaosOptions {
  durationMs?: number;
  maxActions?: number;
  seed?: number;
  weights?: Partial<Record<ChaosAction, number>>;
  typeStrings?: string[];
  keyList?: string[];
  avoidNavigation?: boolean;
  stopOnError?: boolean;
}

const DEFAULT_WEIGHTS: Record<ChaosAction, number> = {
  click: 40, scroll: 20, key: 15, type: 10, hover: 10, resize: 5,
};
const DEFAULT_TYPE_STRINGS: string[] = ['a', 'test', ' ', '123', ''];
const DEFAULT_KEYS: string[] = ['Tab', 'Enter', 'Escape', 'ArrowDown', 'ArrowUp', 'Space'];
const CANDIDATE_SELECTOR = 'button, a[href], [role="button"], input, textarea, select';
const HOVER_SELECTOR = 'button, a, [role="button"], [role="link"], [role="menuitem"], [tabindex], img, svg';
const EDITABLE_SELECTOR = 'input:not([type="hidden"]):not([disabled]), textarea:not([disabled])';
const REFRESH_EVERY = 10;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickAction(rand: () => number, weights: Record<ChaosAction, number>): ChaosAction {
  const entries = Object.entries(weights) as [ChaosAction, number][];
  const total = entries.reduce((n, [, w]) => n + Math.max(0, w), 0);
  if (total <= 0) return 'click';
  let r = rand() * total;
  for (const [action, w] of entries) {
    r -= Math.max(0, w);
    if (r <= 0) return action;
  }
  return entries[entries.length - 1][0];
}

function randInt(rand: () => number, min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}

function pickOne<T>(rand: () => number, list: readonly T[]): T | undefined {
  if (list.length === 0) return undefined;
  return list[Math.floor(rand() * list.length)];
}

async function describeHandle(handle: ElementHandle<Element>): Promise<string> {
  try {
    return await handle.evaluate((el: Element): string => {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const name = el.getAttribute('name');
      const role = el.getAttribute('role');
      const type = el.getAttribute('type');
      const testid = el.getAttribute('data-testid');
      const text = (el.textContent ?? '').trim().slice(0, 30);
      const parts = [tag + id];
      if (testid) parts.push(`[data-testid="${testid}"]`);
      if (role) parts.push(`[role="${role}"]`);
      if (type) parts.push(`[type="${type}"]`);
      if (name) parts.push(`[name="${name}"]`);
      if (text) parts.push(`"${text}"`);
      return parts.join(' ');
    });
  } catch {
    return '<detached>';
  }
}

async function isSameOrigin(handle: ElementHandle<Element>, origin: string): Promise<boolean> {
  try {
    return await handle.evaluate((el: Element, o: string): boolean => {
      if (el.tagName !== 'A') return true;
      const href = (el as HTMLAnchorElement).href;
      if (!href) return true;
      try {
        const u = new URL(href, window.location.href);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        return u.origin === o;
      } catch {
        return false;
      }
    }, origin);
  } catch {
    return false;
  }
}

async function isVisible(handle: ElementHandle<Element>): Promise<boolean> {
  try { return await handle.isVisible(); } catch { return false; }
}

async function installRejectionCounter(page: Page): Promise<void> {
  await page.evaluate((): void => {
    const w = window as unknown as {
      __uxinspect_rejections__?: { count: number; messages: string[] };
    };
    if (w.__uxinspect_rejections__) return;
    const store = { count: 0, messages: [] as string[] };
    w.__uxinspect_rejections__ = store;
    window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
      store.count += 1;
      const reason = e.reason;
      const msg =
        reason instanceof Error ? reason.message
        : typeof reason === 'string' ? reason
        : (() => { try { return JSON.stringify(reason); } catch { return String(reason); } })();
      store.messages.push(msg.slice(0, 500));
    });
  });
}

async function readRejections(page: Page): Promise<string[]> {
  try {
    return await page.evaluate((): string[] => {
      const w = window as unknown as {
        __uxinspect_rejections__?: { count: number; messages: string[] };
      };
      const store = w.__uxinspect_rejections__;
      if (!store) return [];
      const copy = store.messages.slice();
      store.messages = [];
      store.count = 0;
      return copy;
    });
  } catch {
    return [];
  }
}

async function refreshCandidates(page: Page, avoidNavigation: boolean): Promise<ElementHandle<Element>[]> {
  let handles: ElementHandle<Element>[] = [];
  try { handles = await page.$$(CANDIDATE_SELECTOR); } catch { return []; }
  if (!avoidNavigation) return handles;
  let origin = '';
  try { origin = new URL(page.url()).origin; } catch { origin = ''; }
  if (!origin) return handles;
  const filtered: ElementHandle<Element>[] = [];
  for (const h of handles) {
    if (await isSameOrigin(h, origin)) filtered.push(h);
  }
  return filtered;
}

async function pickFirstVisible(page: Page, selector: string): Promise<ElementHandle<Element> | undefined> {
  let handles: ElementHandle<Element>[] = [];
  try { handles = await page.$$(selector); } catch { return undefined; }
  for (const h of handles) {
    if (await isVisible(h)) return h;
  }
  return undefined;
}

export async function runChaos(page: Page, opts?: ChaosOptions): Promise<ChaosResult> {
  const durationMs = opts?.durationMs ?? 15000;
  const maxActions = opts?.maxActions ?? 100;
  const seed = opts?.seed ?? Date.now();
  const avoidNavigation = opts?.avoidNavigation ?? true;
  const stopOnError = opts?.stopOnError ?? false;
  const typeStrings = opts?.typeStrings ?? DEFAULT_TYPE_STRINGS;
  const keyList = opts?.keyList ?? DEFAULT_KEYS;
  const weights: Record<ChaosAction, number> = { ...DEFAULT_WEIGHTS, ...(opts?.weights ?? {}) };

  const rand = mulberry32(seed >>> 0);
  const startUrl = page.url();
  const start = Date.now();
  const events: ChaosEvent[] = [];
  const errors: ChaosError[] = [];
  const actionsByKind: Record<ChaosAction, number> = {
    click: 0, type: 0, scroll: 0, key: 0, hover: 0, resize: 0,
  };

  let currentEventIndex = -1;

  const onConsole = (msg: ConsoleMessage): void => {
    if (msg.type() !== 'error') return;
    errors.push({
      kind: 'console',
      message: msg.text().slice(0, 2000),
      url: msg.location().url || undefined,
      atEventIndex: currentEventIndex,
    });
  };
  const onPageError = (err: Error): void => {
    errors.push({
      kind: 'pageerror',
      message: (err.message || String(err)).slice(0, 2000),
      atEventIndex: currentEventIndex,
    });
  };
  const onRequestFailed = (req: Request): void => {
    const failure = req.failure();
    const reason = failure?.errorText ?? 'request failed';
    errors.push({
      kind: 'requestfailed',
      message: `${req.method()} ${req.url()} failed: ${reason}`.slice(0, 2000),
      url: req.url(),
      atEventIndex: currentEventIndex,
    });
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('requestfailed', onRequestFailed);

  try { await installRejectionCounter(page); } catch { /* page may not be ready */ }

  let candidates: ElementHandle<Element>[] = await refreshCandidates(page, avoidNavigation);
  let crashed = false;
  const deadline = start + durationMs;

  for (let i = 0; i < maxActions; i++) {
    if (Date.now() >= deadline) break;
    if (page.isClosed()) { crashed = true; break; }

    if (i > 0 && i % REFRESH_EVERY === 0) {
      candidates = await refreshCandidates(page, avoidNavigation);
    }

    const action = pickAction(rand, weights);
    const event: ChaosEvent = { action, timestamp: Date.now() - start };
    events.push(event);
    currentEventIndex = events.length - 1;

    try {
      if (action === 'click') {
        const handle = pickOne(rand, candidates);
        if (!handle) {
          event.error = 'no-candidates';
        } else {
          event.target = await describeHandle(handle);
          await handle.click({ timeout: 1500, trial: false });
          actionsByKind.click += 1;
        }
      } else if (action === 'type') {
        const handle = await pickFirstVisible(page, EDITABLE_SELECTOR);
        if (!handle) {
          event.error = 'no-editable';
        } else {
          const value = pickOne(rand, typeStrings) ?? '';
          event.target = await describeHandle(handle);
          event.value = value;
          await handle.focus().catch(() => undefined);
          if (value.length > 0) {
            await page.keyboard.type(value, { delay: 10 });
          } else {
            await page.keyboard.press('Backspace');
          }
          actionsByKind.type += 1;
        }
      } else if (action === 'scroll') {
        const dy = randInt(rand, -800, 800);
        event.value = String(dy);
        await page.evaluate((n: number) => { window.scrollBy(0, n); }, dy);
        actionsByKind.scroll += 1;
      } else if (action === 'key') {
        const key = pickOne(rand, keyList) ?? 'Tab';
        event.value = key;
        await page.keyboard.press(key);
        actionsByKind.key += 1;
      } else if (action === 'hover') {
        const handle = await pickFirstVisible(page, HOVER_SELECTOR);
        if (!handle) {
          event.error = 'no-hoverable';
        } else {
          event.target = await describeHandle(handle);
          await handle.hover({ timeout: 1500, trial: false }).catch(() => undefined);
          actionsByKind.hover += 1;
        }
      } else if (action === 'resize') {
        const w = randInt(rand, 320, 1920);
        const h = randInt(rand, 480, 1080);
        event.value = `${w}x${h}`;
        await page.setViewportSize({ width: w, height: h });
        actionsByKind.resize += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      event.error = message.slice(0, 500);
    }

    if (stopOnError && errors.length > 0) break;
    if (page.isClosed()) { crashed = true; break; }

    const delay = randInt(rand, 40, 120);
    await new Promise<void>((resolve) => { setTimeout(resolve, delay); });
  }

  const leftoverRejections = await readRejections(page);
  for (const message of leftoverRejections) {
    errors.push({
      kind: 'unhandled-rejection',
      message,
      atEventIndex: events.length - 1,
    });
  }

  page.off('console', onConsole);
  page.off('pageerror', onPageError);
  page.off('requestfailed', onRequestFailed);

  const finalUrl = page.isClosed() ? startUrl : page.url();
  const totalActions = Object.values(actionsByKind).reduce((n, v) => n + v, 0);

  return {
    page: startUrl,
    totalActions,
    actionsByKind,
    events,
    errors,
    durationMs: Date.now() - start,
    finalUrl,
    crashed,
    passed: !crashed && errors.length === 0,
  };
}
