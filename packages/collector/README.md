# @uxinspect/collector

Drop-in browser collector for real-user metrics. Ships as a **<5KB gzipped** bundle with zero runtime dependencies.

Captures:

- **Page views** on `DOMContentLoaded` plus SPA navigation (`pushState` / `replaceState` / `popstate` / `hashchange`).
- **Clicks** (delegated, capture-phase) with stable selector and redacted text.
- **Web Vitals**: LCP, INP, CLS, FCP, TTFB via `PerformanceObserver` and navigation timing.
- **Console errors**: wraps `console.error`, `window.onerror`, `unhandledrejection`.
- **Network failures**: wraps `fetch` and `XMLHttpRequest`, reports status >= 400 and network errors.

Ships to `https://api.uxinspect.com/v1/ingest` by default, batched and retried.

## Install

### Script tag (auto-init)

```html
<script
  async
  src="https://cdn.uxinspect.com/collector/v1/collector.min.js"
  data-site-id="YOUR_SITE_ID"
></script>
```

Auto-init reads these data attributes:

| attribute | default | description |
| --- | --- | --- |
| `data-site-id` | (required) | site identifier issued in the dashboard |
| `data-endpoint` | `https://api.uxinspect.com/v1/ingest` | override ingest URL |
| `data-sample-rate` | `1` | fraction of sessions to record, 0..1 |

### NPM

```bash
npm install @uxinspect/collector
```

```ts
import { init } from "@uxinspect/collector";

init({
  siteId: "YOUR_SITE_ID",
  sampleRate: 0.25,
  privacy: { mask: [".sensitive", "[data-redact]"] },
});
```

## API

```ts
init(opts: {
  siteId: string;
  endpoint?: string;       // default: https://api.uxinspect.com/v1/ingest
  sampleRate?: number;     // 0..1, default 1
  privacy?: {
    mask?: string[];       // extra CSS selectors to treat as private
    disableRegex?: boolean;// default false
  };
  debug?: boolean;         // log transport errors to console
}): void
```

`init()` is idempotent — subsequent calls are no-ops.

## Privacy defaults

The collector is private by default. Out of the box it:

1. **Masks all `<input>`, `<textarea>` and `[type='password']` elements.** Click events on these elements ship without text content.
2. **Treats `[data-private]` and `[data-uxi-private]` as opt-in private.** Any element (or ancestor) carrying these attributes has text stripped.
3. **Redacts emails, phone numbers and credit card patterns** from text event content before it leaves the page. The card regex runs first so 16-digit sequences are never mis-matched as phone numbers.
4. **Truncates** free text to 120 characters.
5. **Skips the ingest endpoint** when wrapping `fetch` / XHR so the collector never records its own traffic.

### IP anonymization

The collector **cannot** prevent the browser from attaching its IP to a network request — that is a physical-layer property of TCP/IP. To comply with GDPR / ePrivacy:

- The ingest worker at `api.uxinspect.com/v1/ingest` truncates the last octet of IPv4 addresses and the last 80 bits of IPv6 addresses **before** any event is persisted. No full IP ever touches storage.
- Customers who self-host the ingest worker should mirror this behaviour (trim `CF-Connecting-IP` before writing to D1/R2).

### Adding more redaction

```ts
init({
  siteId: "…",
  privacy: {
    mask: [
      ".user-email",
      "[data-sensitive]",
      "#checkout-form input",
    ],
  },
});
```

## Transport behaviour

- Events buffer in memory, auto-flush every 4s or every 40 events.
- On `visibilitychange: hidden` the in-memory buffer flushes with `fetch({ keepalive: true })`.
- On `pagehide` we use `navigator.sendBeacon` for the final flush.
- Failed flushes persist to `sessionStorage._uxi_q` and retry with exponential backoff (0.8s, 1.6s, 3.2s, 6.4s; max 4 retries per batch).
- Storage is capped at 200 events to protect the 5MB sessionStorage quota.

## Size budget

| artefact | size |
| --- | --- |
| `dist/collector.min.js` (minified) | see `dist/size.json` after build |
| `dist/collector.min.js` (minified + gzipped) | **<5KB enforced** |

The build aborts if the gzipped output crosses 5KB. `test/size.test.mjs` asserts the same budget so CI catches regressions.

```bash
npm run build   # produces dist/collector.min.js + dist/collector.esm.js + dist/size.json
npm test        # runs all unit tests including size assertion
```

## Browser support

ES2020 baseline. Tested on evergreen Chrome, Firefox, Safari, Edge. No polyfills shipped.

## License

MIT.
