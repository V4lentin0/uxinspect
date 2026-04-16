import type { CollectorEvent, ResolvedConfig } from "./types.js";

const QUEUE_KEY = "_uxi_q";
const MAX_BATCH = 40;
const FLUSH_MS = 4000;
const MAX_RETRY = 4;
const BASE_BACKOFF = 800;
const MAX_QUEUE = 200; // cap stored events to avoid blowing sessionStorage

export interface TransportDeps {
  now?: () => number;
  storage?: Storage | null;
  fetchImpl?: typeof fetch;
  beaconImpl?: (url: string, body: BodyInit) => boolean;
  timers?: {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
}

// Transport owns the in-memory buffer plus a persisted overflow in
// sessionStorage for retry across page loads. It exposes push/flush/drain
// so tests can drive it without a real browser.
export class Transport {
  private buf: CollectorEvent[] = [];
  private retries = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;

  constructor(
    private cfg: ResolvedConfig,
    private deps: TransportDeps = {}
  ) {
    this.restore();
  }

  push(ev: CollectorEvent): void {
    this.buf.push(ev);
    if (this.buf.length >= MAX_BATCH) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  // Merge persisted + in-memory queue and send everything. On transport
  // failure, persist back to storage and schedule a backoff retry.
  async flush(): Promise<boolean> {
    if (this.sending) return false;
    if (this.buf.length === 0) return true;
    this.clearTimer();
    this.sending = true;
    const batch = this.buf.splice(0, this.buf.length);
    const payload = this.serialize(batch);
    const fetchFn = this.deps.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);
    if (!fetchFn) {
      this.requeue(batch);
      this.sending = false;
      return false;
    }
    try {
      const res = await fetchFn(this.cfg.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        keepalive: true,
        credentials: "omit",
        mode: "cors",
      });
      if (!res.ok && res.status >= 500) throw new Error("http " + res.status);
      this.retries = 0;
      this.persist();
      this.sending = false;
      return true;
    } catch (e) {
      this.sending = false;
      this.requeue(batch);
      this.retries++;
      if (this.retries <= MAX_RETRY) {
        const delay = BASE_BACKOFF * Math.pow(2, this.retries - 1);
        this.deps.timers?.setTimeout?.(() => void this.flush(), delay) ??
          setTimeout(() => void this.flush(), delay);
      }
      if (this.cfg.debug) console.warn("[uxi] transport error", e);
      return false;
    }
  }

  // Synchronous emergency drain used during pagehide — uses sendBeacon
  // because fetch keepalive is not guaranteed to complete on unload.
  drain(): void {
    if (this.buf.length === 0) return;
    const batch = this.buf.splice(0, this.buf.length);
    const body = this.serialize(batch);
    const beacon = this.deps.beaconImpl ??
      (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function"
        ? navigator.sendBeacon.bind(navigator)
        : undefined);
    const blob = typeof Blob !== "undefined"
      ? new Blob([body], { type: "application/json" })
      : body;
    let ok = false;
    if (beacon) {
      try { ok = beacon(this.cfg.endpoint, blob as BodyInit); } catch { ok = false; }
    }
    if (!ok) {
      this.requeue(batch);
    }
  }

  // Testing hook.
  queueSize(): number {
    return this.buf.length;
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    const set = this.deps.timers?.setTimeout ?? setTimeout;
    this.timer = set(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_MS);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    const clear = this.deps.timers?.clearTimeout ?? clearTimeout;
    clear(this.timer);
    this.timer = null;
  }

  private requeue(batch: CollectorEvent[]): void {
    // prepend so older events go out first
    this.buf = batch.concat(this.buf);
    if (this.buf.length > MAX_QUEUE) {
      this.buf.splice(0, this.buf.length - MAX_QUEUE);
    }
    this.persist();
  }

  private serialize(batch: CollectorEvent[]): string {
    return JSON.stringify({
      siteId: this.cfg.siteId,
      sid: this.cfg.sid,
      events: batch,
    });
  }

  private persist(): void {
    const s = this.store();
    if (!s) return;
    try {
      if (this.buf.length === 0) s.removeItem(QUEUE_KEY);
      else s.setItem(QUEUE_KEY, JSON.stringify(this.buf));
    } catch { /* quota — ignore */ }
  }

  private restore(): void {
    const s = this.store();
    if (!s) return;
    try {
      const raw = s.getItem(QUEUE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) this.buf = parsed.slice(-MAX_QUEUE);
    } catch { /* ignore */ }
  }

  private store(): Storage | null {
    if (this.deps.storage !== undefined) return this.deps.storage;
    try { return typeof sessionStorage !== "undefined" ? sessionStorage : null; }
    catch { return null; }
  }
}
