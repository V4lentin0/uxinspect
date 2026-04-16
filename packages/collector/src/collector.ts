import type { InitOptions, ResolvedConfig } from "./types.js";
import { Transport } from "./transport.js";
import {
  installClicks,
  installErrors,
  installNetwork,
  installPageView,
  installVitals,
} from "./events.js";

export type { InitOptions, CollectorEvent, PrivacyConfig } from "./types.js";

const DEFAULT_ENDPOINT = "https://api.uxinspect.com/v1/ingest";
let initialized = false;
let teardown: (() => void) | null = null;

// Session id: random 16 hex chars, stored for the tab's life in
// sessionStorage so a reload stays in the same session.
function sessionId(): string {
  const key = "_uxi_sid";
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const rnd = new Uint8Array(8);
    crypto.getRandomValues(rnd);
    const id = Array.from(rnd, (b) => b.toString(16).padStart(2, "0")).join("");
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return Math.random().toString(16).slice(2, 18);
  }
}

function resolve(opts: InitOptions): ResolvedConfig {
  if (!opts || !opts.siteId) throw new Error("uxinspect: siteId required");
  return {
    siteId: opts.siteId,
    endpoint: opts.endpoint || DEFAULT_ENDPOINT,
    sampleRate: clamp01(opts.sampleRate ?? 1),
    privacy: {
      mask: opts.privacy?.mask ?? [],
      disableRegex: opts.privacy?.disableRegex ?? false,
    },
    debug: !!opts.debug,
    sid: sessionId(),
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 1;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// Public API. Idempotent — calling init() twice is a no-op.
export function init(opts: InitOptions): void {
  if (typeof window === "undefined") return; // SSR-safe
  if (initialized) return;
  if (Math.random() > clamp01(opts.sampleRate ?? 1)) return;
  initialized = true;
  const cfg = resolve(opts);
  const transport = new Transport(cfg);
  const offs = [
    installPageView(cfg, transport),
    installClicks(cfg, transport),
    installVitals(cfg, transport),
    installErrors(cfg, transport),
    installNetwork(cfg, transport),
  ];
  const onHide = () => transport.drain();
  window.addEventListener("pagehide", onHide);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void transport.flush();
  });

  teardown = () => {
    for (const off of offs) try { off(); } catch { /* ignore */ }
    window.removeEventListener("pagehide", onHide);
    initialized = false;
  };
}

// Testing / SPA dispose helper.
export function _stop(): void {
  teardown?.();
  teardown = null;
}

// UMD-style side-effect: if loaded via <script data-site-id="..."> auto-init.
if (typeof document !== "undefined") {
  const scripts = document.getElementsByTagName("script");
  for (let i = scripts.length - 1; i >= 0; i--) {
    const s = scripts[i];
    const siteId = s.getAttribute("data-site-id");
    if (siteId) {
      init({
        siteId,
        endpoint: s.getAttribute("data-endpoint") || undefined,
        sampleRate: s.getAttribute("data-sample-rate")
          ? Number(s.getAttribute("data-sample-rate"))
          : undefined,
      });
      break;
    }
  }
}
