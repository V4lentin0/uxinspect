// Concurrency audit — 2-tab race detection (P4 #41).
//
// Opens two pages from the same BrowserContext (shared auth) OR two separate
// contexts (for session-stomp), coordinates actions via Promise.all, then
// inspects the resulting server responses + client DOM/storage state for
// classic concurrency bugs:
//
//   1. double-submit    — two tabs POST the same form in parallel; server
//                         must reject duplicates or merge idempotently.
//   2. stale-write      — tab A loads a record, tab B mutates + saves it,
//                         tab A then PUT/POSTs with the old version; server
//                         must return 409/412 (optimistic lock), not accept
//                         a silent overwrite.
//   3. session-stomp    — login in context A, login again in context B with
//                         the same user; the older session should either
//                         still work (multi-session) or fail gracefully.
//   4. ws-dup           — two tabs subscribe to the same websocket event;
//                         trigger once, detect duplicate or lost messages.
//   5. storage-race     — two tabs write to the same localStorage key; the
//                         loser should receive a `storage` event and react,
//                         not silently fork state.
//
// All scenarios run real Playwright actions — no mocking. Each scenario is
// independent and fails soft (its diagnostic is attached to the result
// instead of throwing), so callers can enable any subset.

import type { Browser, BrowserContext, Page, Request, Response } from 'playwright';

export type ConcurrencyScenario =
  | 'double-submit'
  | 'stale-write'
  | 'session-stomp'
  | 'ws-dup'
  | 'storage-race';

export interface ConcurrencyConfig {
  /** Which scenarios to run. Defaults to all applicable to the given inputs. */
  scenarios?: ConcurrencyScenario[];
  /** Page that exposes a submittable form — used by double-submit. */
  flowFormUrl?: string;
  /** Page that loads + edits an existing record — used by stale-write. */
  flowEditUrl?: string;
  /** Credentials used by session-stomp (and any login side-effects). */
  credentials?: { username: string; password: string };
  /** Per-scenario timeout (ms). Defaults to 15_000. */
  timeoutMs?: number;
  /**
   * CSS selector for the submit button on the double-submit form.
   * Defaults to `button[type="submit"], input[type="submit"]`.
   */
  submitSelector?: string;
  /**
   * URL pattern (substring match) used to recognise the form-submit network
   * request. If omitted, any non-GET request fired by the submit click is
   * considered the submit request.
   */
  submitUrlIncludes?: string;
  /**
   * URL pattern (substring match) used to recognise the edit/save network
   * request for stale-write.
   */
  editUrlIncludes?: string;
  /**
   * Storage key both tabs race on. Defaults to `uxinspect:race-key`.
   */
  storageKey?: string;
  /**
   * URL to visit for the storage-race scenario — defaults to `flowFormUrl`
   * if not set. Any same-origin page works.
   */
  storageRaceUrl?: string;
  /**
   * Selectors for login form — used by session-stomp.
   * Defaults cover typical `name=username`/`name=password` forms.
   */
  loginSelectors?: {
    url?: string;
    username?: string;
    password?: string;
    submit?: string;
  };
  /**
   * URL to visit after login to verify the older session still works.
   */
  postLoginProbeUrl?: string;
  /**
   * WebSocket event the app fires on some trigger — used by ws-dup.
   * The trigger selector is clicked in tab A only; both tabs observe
   * frame traffic to count duplicates.
   */
  wsTriggerSelector?: string;
  /** Optional URL to navigate both WS tabs to. */
  wsUrl?: string;
}

export interface RaceIssue {
  scenario: ConcurrencyScenario;
  kind:
    | 'duplicate-accepted'
    | 'stale-overwrite-accepted'
    | 'session-stomp-no-feedback'
    | 'ws-duplicate-message'
    | 'ws-missed-message'
    | 'storage-silent-fork'
    | 'scenario-skipped'
    | 'scenario-error';
  detail: string;
  evidence?: Record<string, unknown>;
}

export interface ScenarioResult {
  scenario: ConcurrencyScenario;
  ran: boolean;
  durationMs: number;
  passed: boolean;
  issues: RaceIssue[];
  notes?: string[];
}

export interface ConcurrencyResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  scenarios: ScenarioResult[];
  issues: RaceIssue[];
  passed: boolean;
}

interface ConcurrencyContext {
  browser?: Browser;
  context: BrowserContext;
}

const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_STORAGE_KEY = 'uxinspect:race-key';
const DEFAULT_SUBMIT_SELECTOR = 'button[type="submit"], input[type="submit"]';

/** Clamp a number of ms to a reasonable range. */
function clampTimeout(ms: number | undefined): number {
  if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return DEFAULT_TIMEOUT;
  return Math.min(Math.max(500, ms), 120_000);
}

function nowMs(): number {
  return Date.now();
}

/** Collect the first POST/PUT/PATCH/DELETE response whose URL matches. */
function waitForSubmitResponse(
  page: Page,
  matcher: (req: Request) => boolean,
  timeoutMs: number,
): Promise<Response | null> {
  const seen = new Set<Request>();
  return new Promise<Response | null>((resolve) => {
    const timer = setTimeout(() => {
      page.off('response', onResponse);
      page.off('request', onRequest);
      resolve(null);
    }, timeoutMs);
    const onRequest = (req: Request): void => {
      if (matcher(req)) seen.add(req);
    };
    const onResponse = (resp: Response): void => {
      if (seen.has(resp.request())) {
        clearTimeout(timer);
        page.off('response', onResponse);
        page.off('request', onRequest);
        resolve(resp);
      }
    };
    page.on('request', onRequest);
    page.on('response', onResponse);
  });
}

function defaultSubmitMatcher(config: ConcurrencyConfig): (req: Request) => boolean {
  const substr = config.submitUrlIncludes;
  return (req: Request): boolean => {
    const method = req.method().toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
    if (substr) return req.url().includes(substr);
    return true;
  };
}

function editMatcher(config: ConcurrencyConfig): (req: Request) => boolean {
  const substr = config.editUrlIncludes ?? config.submitUrlIncludes;
  return (req: Request): boolean => {
    const method = req.method().toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
    if (substr) return req.url().includes(substr);
    return true;
  };
}

async function safeClose(page: Page): Promise<void> {
  try {
    await page.close();
  } catch {
    /* swallow */
  }
}

async function safeContextClose(context: BrowserContext): Promise<void> {
  try {
    await context.close();
  } catch {
    /* swallow */
  }
}

function addIssue(
  issues: RaceIssue[],
  scenario: ConcurrencyScenario,
  kind: RaceIssue['kind'],
  detail: string,
  evidence?: Record<string, unknown>,
): void {
  const issue: RaceIssue = { scenario, kind, detail };
  if (evidence !== undefined) issue.evidence = evidence;
  issues.push(issue);
}

function skip(
  scenario: ConcurrencyScenario,
  startedAt: number,
  reason: string,
): ScenarioResult {
  const issues: RaceIssue[] = [];
  addIssue(issues, scenario, 'scenario-skipped', reason);
  return {
    scenario,
    ran: false,
    durationMs: nowMs() - startedAt,
    passed: true,
    issues,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Scenario 1: double-submit
 * ──────────────────────────────────────────────────────────────────────*/

async function runDoubleSubmit(
  ctx: ConcurrencyContext,
  config: ConcurrencyConfig,
): Promise<ScenarioResult> {
  const started = nowMs();
  const issues: RaceIssue[] = [];
  const notes: string[] = [];
  if (!config.flowFormUrl) {
    return skip('double-submit', started, 'flowFormUrl not configured');
  }
  const timeoutMs = clampTimeout(config.timeoutMs);
  const submitSelector = config.submitSelector ?? DEFAULT_SUBMIT_SELECTOR;
  const matcher = defaultSubmitMatcher(config);

  const pageA = await ctx.context.newPage();
  const pageB = await ctx.context.newPage();
  try {
    await Promise.all([
      pageA.goto(config.flowFormUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs }),
      pageB.goto(config.flowFormUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs }),
    ]);

    // Wait for the submit button in both before racing.
    await Promise.all([
      pageA.locator(submitSelector).first().waitFor({ state: 'visible', timeout: timeoutMs }),
      pageB.locator(submitSelector).first().waitFor({ state: 'visible', timeout: timeoutMs }),
    ]);

    const respA = waitForSubmitResponse(pageA, matcher, timeoutMs);
    const respB = waitForSubmitResponse(pageB, matcher, timeoutMs);
    await Promise.all([
      pageA.locator(submitSelector).first().click({ timeout: timeoutMs }).catch(() => undefined),
      pageB.locator(submitSelector).first().click({ timeout: timeoutMs }).catch(() => undefined),
    ]);

    const [rA, rB] = await Promise.all([respA, respB]);
    const statusA = rA?.status() ?? null;
    const statusB = rB?.status() ?? null;
    notes.push(`tab A status=${statusA ?? 'none'}, tab B status=${statusB ?? 'none'}`);

    const ok = (s: number | null): boolean => s !== null && s >= 200 && s < 300;
    if (ok(statusA) && ok(statusB)) {
      addIssue(
        issues,
        'double-submit',
        'duplicate-accepted',
        `Both tabs received 2xx for the same submit (A=${statusA}, B=${statusB}). Backend should dedup or return 409/429 for the second request.`,
        { statusA, statusB },
      );
    }
  } catch (e) {
    addIssue(issues, 'double-submit', 'scenario-error', `unexpected error: ${String(e)}`);
  } finally {
    await safeClose(pageA);
    await safeClose(pageB);
  }

  const result: ScenarioResult = {
    scenario: 'double-submit',
    ran: true,
    durationMs: nowMs() - started,
    passed: issues.length === 0,
    issues,
  };
  if (notes.length > 0) result.notes = notes;
  return result;
}

/* ────────────────────────────────────────────────────────────────────────
 * Scenario 2: stale-write
 * ──────────────────────────────────────────────────────────────────────*/

async function runStaleWrite(
  ctx: ConcurrencyContext,
  config: ConcurrencyConfig,
): Promise<ScenarioResult> {
  const started = nowMs();
  const issues: RaceIssue[] = [];
  const notes: string[] = [];
  if (!config.flowEditUrl) {
    return skip('stale-write', started, 'flowEditUrl not configured');
  }
  const timeoutMs = clampTimeout(config.timeoutMs);
  const submitSelector = config.submitSelector ?? DEFAULT_SUBMIT_SELECTOR;
  const matcher = editMatcher(config);

  const pageA = await ctx.context.newPage();
  const pageB = await ctx.context.newPage();
  try {
    // Tab A loads the edit form first (capturing "v1" of the record).
    await pageA.goto(config.flowEditUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await pageA.locator(submitSelector).first().waitFor({ state: 'visible', timeout: timeoutMs });

    // Tab B loads, edits, and saves — producing "v2" on the server.
    await pageB.goto(config.flowEditUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await pageB.locator(submitSelector).first().waitFor({ state: 'visible', timeout: timeoutMs });
    const bResp = waitForSubmitResponse(pageB, matcher, timeoutMs);
    await pageB.locator(submitSelector).first().click({ timeout: timeoutMs }).catch(() => undefined);
    const rB = await bResp;
    notes.push(`tab B (first writer) status=${rB?.status() ?? 'none'}`);

    // Tab A now submits with the stale version — should get 409/412/428.
    const aResp = waitForSubmitResponse(pageA, matcher, timeoutMs);
    await pageA.locator(submitSelector).first().click({ timeout: timeoutMs }).catch(() => undefined);
    const rA = await aResp;
    const statusA = rA?.status() ?? null;
    notes.push(`tab A (stale writer) status=${statusA ?? 'none'}`);

    const conflictCodes = new Set([409, 410, 412, 428]);
    if (statusA !== null && statusA >= 200 && statusA < 300 && !conflictCodes.has(statusA)) {
      addIssue(
        issues,
        'stale-write',
        'stale-overwrite-accepted',
        `Stale write accepted with status ${statusA}. Expected 409/412/428 (ETag/If-Match optimistic lock).`,
        { statusA, statusB: rB?.status() ?? null },
      );
    }
  } catch (e) {
    addIssue(issues, 'stale-write', 'scenario-error', `unexpected error: ${String(e)}`);
  } finally {
    await safeClose(pageA);
    await safeClose(pageB);
  }

  const result: ScenarioResult = {
    scenario: 'stale-write',
    ran: true,
    durationMs: nowMs() - started,
    passed: issues.length === 0,
    issues,
  };
  if (notes.length > 0) result.notes = notes;
  return result;
}

/* ────────────────────────────────────────────────────────────────────────
 * Scenario 3: session-stomp
 * ──────────────────────────────────────────────────────────────────────*/

async function runSessionStomp(
  ctx: ConcurrencyContext,
  config: ConcurrencyConfig,
): Promise<ScenarioResult> {
  const started = nowMs();
  const issues: RaceIssue[] = [];
  const notes: string[] = [];
  if (!config.credentials || !ctx.browser) {
    return skip(
      'session-stomp',
      started,
      !ctx.browser
        ? 'session-stomp requires a Browser (to create a second isolated context); none provided'
        : 'credentials not configured',
    );
  }
  const timeoutMs = clampTimeout(config.timeoutMs);
  const loginUrl = config.loginSelectors?.url ?? config.flowFormUrl;
  if (!loginUrl) {
    return skip('session-stomp', started, 'login url not configured');
  }
  const userSelector = config.loginSelectors?.username ?? 'input[name="username"], input[type="email"], input[name="email"]';
  const passSelector = config.loginSelectors?.password ?? 'input[type="password"]';
  const submitSelector = config.loginSelectors?.submit ?? DEFAULT_SUBMIT_SELECTOR;
  const probeUrl = config.postLoginProbeUrl ?? loginUrl;

  // Separate context so cookies don't leak between "browser A" and "browser B".
  const contextB = await ctx.browser.newContext();
  const pageA = await ctx.context.newPage();
  const pageB = await contextB.newPage();
  try {
    const loginOnce = async (page: Page): Promise<void> => {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await page.fill(userSelector, config.credentials!.username).catch(() => undefined);
      await page.fill(passSelector, config.credentials!.password).catch(() => undefined);
      await page.locator(submitSelector).first().click({ timeout: timeoutMs }).catch(() => undefined);
      await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined);
    };

    await loginOnce(pageA);
    await loginOnce(pageB);

    // Probe tab A — does its session still carry cookies + authenticated
    // content? We look at the response status code + URL of the probe.
    const probeResp = await pageA
      .goto(probeUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      .catch(() => null);
    const probeStatus = probeResp?.status() ?? null;
    const probeUrlFinal = pageA.url();
    notes.push(`tab A probe status=${probeStatus ?? 'none'}, url=${probeUrlFinal}`);

    // Heuristic: if the probe returned 5xx OR the URL redirected back to a
    // `/login` path (so tab A silently got logged out without feedback),
    // that's a broken half-state. 401/403 with an explicit error page is
    // acceptable (the app told the user).
    const redirectedToLogin = /\/(login|signin|auth)(?:$|\/|\?)/i.test(probeUrlFinal);
    const serverError = probeStatus !== null && probeStatus >= 500;
    if (serverError) {
      addIssue(
        issues,
        'session-stomp',
        'session-stomp-no-feedback',
        `After a second login of the same user, tab A's first request returned ${probeStatus}. Expected either success (multi-session allowed) or a user-facing 401/403 page.`,
        { probeStatus, probeUrl: probeUrlFinal },
      );
    } else if (redirectedToLogin && probeStatus !== null && probeStatus >= 200 && probeStatus < 300) {
      // Silent redirect to /login with a 2xx — user wasn't told why.
      // Only flag if the app didn't render a visible auth prompt.
      const alertCount = await pageA
        .locator('[role="alert"], .alert, .error, .flash-error')
        .count()
        .catch(() => 0);
      if (alertCount === 0) {
        addIssue(
          issues,
          'session-stomp',
          'session-stomp-no-feedback',
          `Tab A was silently redirected to ${probeUrlFinal} with no visible auth message after a concurrent login.`,
          { probeStatus, probeUrl: probeUrlFinal },
        );
      }
    }
  } catch (e) {
    addIssue(issues, 'session-stomp', 'scenario-error', `unexpected error: ${String(e)}`);
  } finally {
    await safeClose(pageA);
    await safeClose(pageB);
    await safeContextClose(contextB);
  }

  const result: ScenarioResult = {
    scenario: 'session-stomp',
    ran: true,
    durationMs: nowMs() - started,
    passed: issues.length === 0,
    issues,
  };
  if (notes.length > 0) result.notes = notes;
  return result;
}

/* ────────────────────────────────────────────────────────────────────────
 * Scenario 4: ws-dup
 * ──────────────────────────────────────────────────────────────────────*/

interface WsFrameRecord {
  tab: 'A' | 'B';
  payload: string;
  receivedAt: number;
}

async function runWsDup(
  ctx: ConcurrencyContext,
  config: ConcurrencyConfig,
): Promise<ScenarioResult> {
  const started = nowMs();
  const issues: RaceIssue[] = [];
  const notes: string[] = [];
  const url = config.wsUrl ?? config.flowFormUrl;
  if (!url) {
    return skip('ws-dup', started, 'wsUrl (or flowFormUrl) not configured');
  }
  const timeoutMs = clampTimeout(config.timeoutMs);

  const pageA = await ctx.context.newPage();
  const pageB = await ctx.context.newPage();
  try {
    const frames: WsFrameRecord[] = [];
    let wsDetected = false;

    const attach = (page: Page, label: 'A' | 'B'): void => {
      page.on('websocket', (ws) => {
        wsDetected = true;
        ws.on('framereceived', (frame) => {
          const payload = typeof frame.payload === 'string'
            ? frame.payload
            : frame.payload.toString('utf8');
          frames.push({ tab: label, payload, receivedAt: nowMs() });
        });
      });
    };
    attach(pageA, 'A');
    attach(pageB, 'B');

    await Promise.all([
      pageA.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }),
      pageB.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }),
    ]);

    // Let the socket settle.
    await pageA.waitForTimeout(Math.min(500, timeoutMs));
    if (config.wsTriggerSelector) {
      await pageA.locator(config.wsTriggerSelector).first().click({ timeout: timeoutMs }).catch(() => undefined);
    }
    // Give frames a moment to land.
    const settleMs = Math.min(1500, Math.max(500, Math.floor(timeoutMs / 4)));
    await pageA.waitForTimeout(settleMs);

    if (!wsDetected) {
      return skip('ws-dup', started, 'no WebSocket handshake observed on either tab');
    }

    const byPayload = new Map<string, WsFrameRecord[]>();
    for (const f of frames) {
      const list = byPayload.get(f.payload);
      if (list) list.push(f);
      else byPayload.set(f.payload, [f]);
    }
    notes.push(`tab A frames=${frames.filter((f) => f.tab === 'A').length}, tab B frames=${frames.filter((f) => f.tab === 'B').length}, unique payloads=${byPayload.size}`);

    // Duplicate within the SAME tab (same payload arriving twice close together)
    // usually indicates a double-subscribe bug.
    for (const [payload, list] of byPayload.entries()) {
      const perTab: Record<'A' | 'B', number> = { A: 0, B: 0 };
      for (const f of list) perTab[f.tab] += 1;
      if (perTab.A >= 2 || perTab.B >= 2) {
        addIssue(
          issues,
          'ws-dup',
          'ws-duplicate-message',
          `Payload observed ${perTab.A + perTab.B} times on same tab — likely double-subscribe.`,
          { payloadPreview: payload.slice(0, 80), perTab },
        );
        break; // one representative is enough
      }
    }

    // Missed message: tab A received frames but tab B received zero after the
    // trigger — with a shared broadcast channel we'd expect both to hear it.
    if (config.wsTriggerSelector) {
      const aCount = frames.filter((f) => f.tab === 'A').length;
      const bCount = frames.filter((f) => f.tab === 'B').length;
      if (aCount > 0 && bCount === 0) {
        addIssue(
          issues,
          'ws-dup',
          'ws-missed-message',
          `Tab A received ${aCount} frames but tab B received 0. If this is a broadcast channel, tab B missed messages.`,
          { aCount, bCount },
        );
      }
    }
  } catch (e) {
    addIssue(issues, 'ws-dup', 'scenario-error', `unexpected error: ${String(e)}`);
  } finally {
    await safeClose(pageA);
    await safeClose(pageB);
  }

  const result: ScenarioResult = {
    scenario: 'ws-dup',
    ran: true,
    durationMs: nowMs() - started,
    passed: issues.length === 0,
    issues,
  };
  if (notes.length > 0) result.notes = notes;
  return result;
}

/* ────────────────────────────────────────────────────────────────────────
 * Scenario 5: storage-race
 * ──────────────────────────────────────────────────────────────────────*/

interface StorageRaceProbe {
  receivedEvent: boolean;
  finalValue: string | null;
}

async function runStorageRace(
  ctx: ConcurrencyContext,
  config: ConcurrencyConfig,
): Promise<ScenarioResult> {
  const started = nowMs();
  const issues: RaceIssue[] = [];
  const notes: string[] = [];
  const url = config.storageRaceUrl ?? config.flowFormUrl;
  if (!url) {
    return skip('storage-race', started, 'storageRaceUrl (or flowFormUrl) not configured');
  }
  const storageKey = config.storageKey ?? DEFAULT_STORAGE_KEY;
  const timeoutMs = clampTimeout(config.timeoutMs);

  const pageA = await ctx.context.newPage();
  const pageB = await ctx.context.newPage();
  try {
    // Install a storage-event listener BEFORE navigation on both pages so
    // we catch the very first cross-tab event. addInitScript runs on every
    // navigation.
    const initScript = `
      (function(){
        window.__uxinspectStorageRace = { events: [], errors: [] };
        try {
          window.addEventListener('storage', function(e){
            try {
              window.__uxinspectStorageRace.events.push({
                key: e.key,
                oldValue: e.oldValue,
                newValue: e.newValue,
                at: Date.now(),
              });
            } catch (err) {
              window.__uxinspectStorageRace.errors.push(String(err));
            }
          });
        } catch (err) {
          window.__uxinspectStorageRace.errors.push(String(err));
        }
      })();
    `;
    await pageA.addInitScript(initScript);
    await pageB.addInitScript(initScript);

    await Promise.all([
      pageA.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }),
      pageB.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }),
    ]);

    // Race: both tabs write a DIFFERENT value for the same key at roughly
    // the same time. Only ONE storage event per tab should fire (for the
    // OTHER tab's write) per the spec.
    await Promise.all([
      pageA.evaluate(
        ({ key, value }: { key: string; value: string }) => {
          localStorage.setItem(key, value);
        },
        { key: storageKey, value: 'from-A' },
      ),
      pageB.evaluate(
        ({ key, value }: { key: string; value: string }) => {
          localStorage.setItem(key, value);
        },
        { key: storageKey, value: 'from-B' },
      ),
    ]);

    // Give the browser a tick to dispatch the cross-tab storage events.
    await pageA.waitForTimeout(Math.min(500, timeoutMs));
    await pageB.waitForTimeout(Math.min(500, timeoutMs));

    const probe = async (page: Page): Promise<StorageRaceProbe> => {
      return page.evaluate((key: string): StorageRaceProbe => {
        type W = Window & { __uxinspectStorageRace?: { events: { key: string | null }[] } };
        const w = window as W;
        const events = w.__uxinspectStorageRace?.events ?? [];
        const matches = events.filter((e) => e.key === key);
        return {
          receivedEvent: matches.length > 0,
          finalValue: localStorage.getItem(key),
        };
      }, storageKey);
    };

    const [probeA, probeB] = await Promise.all([probe(pageA), probe(pageB)]);
    notes.push(
      `tab A: storageEvent=${probeA.receivedEvent}, final=${probeA.finalValue}; tab B: storageEvent=${probeB.receivedEvent}, final=${probeB.finalValue}`,
    );

    // If neither tab received the other's storage event AND their final
    // localStorage values disagree, the app is "silently forking" — each
    // tab is holding its own version with no chance to react.
    const forked =
      probeA.finalValue !== probeB.finalValue &&
      !probeA.receivedEvent &&
      !probeB.receivedEvent;
    if (forked) {
      addIssue(
        issues,
        'storage-race',
        'storage-silent-fork',
        `Tabs disagree on localStorage[${storageKey}] (A=${probeA.finalValue}, B=${probeB.finalValue}) and neither received a storage event. App can't reconcile concurrent writes.`,
        { keyName: storageKey, finalA: probeA.finalValue, finalB: probeB.finalValue },
      );
    }
  } catch (e) {
    addIssue(issues, 'storage-race', 'scenario-error', `unexpected error: ${String(e)}`);
  } finally {
    await safeClose(pageA);
    await safeClose(pageB);
  }

  const result: ScenarioResult = {
    scenario: 'storage-race',
    ran: true,
    durationMs: nowMs() - started,
    passed: issues.length === 0,
    issues,
  };
  if (notes.length > 0) result.notes = notes;
  return result;
}

/* ────────────────────────────────────────────────────────────────────────
 * Top-level runner
 * ──────────────────────────────────────────────────────────────────────*/

const SCENARIO_RUNNERS: Record<
  ConcurrencyScenario,
  (ctx: ConcurrencyContext, config: ConcurrencyConfig) => Promise<ScenarioResult>
> = {
  'double-submit': runDoubleSubmit,
  'stale-write': runStaleWrite,
  'session-stomp': runSessionStomp,
  'ws-dup': runWsDup,
  'storage-race': runStorageRace,
};

const DEFAULT_SCENARIOS: ConcurrencyScenario[] = [
  'double-submit',
  'stale-write',
  'session-stomp',
  'ws-dup',
  'storage-race',
];

/**
 * Run a concurrency/race audit against an already-authenticated
 * BrowserContext. Each scenario runs sequentially (but uses real parallel
 * Playwright actions internally via Promise.all). Failures are non-fatal:
 * a scenario that throws or can't configure itself records a `scenario-error`
 * or `scenario-skipped` issue and the overall audit continues.
 *
 * Passing `{ browser }` in the context lets `session-stomp` spin up a second
 * isolated BrowserContext — without it, that scenario is skipped.
 */
export async function runConcurrencyAudit(
  context: ConcurrencyContext,
  opts: ConcurrencyConfig = {},
): Promise<ConcurrencyResult> {
  const startedAtMs = nowMs();
  const startedAt = new Date(startedAtMs).toISOString();
  const scenarios = opts.scenarios ?? DEFAULT_SCENARIOS;
  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    const runner = SCENARIO_RUNNERS[s];
    if (!runner) continue;
    try {
      const r = await runner(context, opts);
      results.push(r);
    } catch (e) {
      // Double-belt: individual runners already guard, but make sure a
      // throw here doesn't abort the whole audit.
      results.push({
        scenario: s,
        ran: true,
        durationMs: 0,
        passed: false,
        issues: [
          {
            scenario: s,
            kind: 'scenario-error',
            detail: `runner threw: ${String(e)}`,
          },
        ],
      });
    }
  }
  const finishedAtMs = nowMs();
  const allIssues = results.flatMap((r) => r.issues);
  // Audit passes iff every scenario passes (skipped scenarios pass).
  const passed = results.every((r) => r.passed);
  return {
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    scenarios: results,
    issues: allIssues,
    passed,
  };
}
