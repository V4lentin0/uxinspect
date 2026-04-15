# uxinspect Flow Recorder

Chrome Manifest V3 extension that records user interactions on any page and
exports them as a uxinspect flow JSON file. No build step, no frameworks, no
bundler — just vanilla HTML/CSS/JS.

Typical workflow:

1. Open the page you want to test.
2. Click the extension icon.
3. Name the flow and hit **Start**.
4. Use the page normally — click, type, navigate, upload.
5. Hit **Stop**, then **Copy JSON** or **Download** to get a ready-to-use flow.
6. Paste into your uxinspect config under `flows`.

## Install (unpacked)

This extension is unpacked — load it directly from the source tree.

1. Open `chrome://extensions` (or any MV3 browser's extensions page).
2. Enable **Developer mode** in the top right.
3. Click **Load unpacked**.
4. Select this directory: `apps/recorder-extension/`.
5. Pin the extension to the toolbar for easy access.

No `npm install` required. The extension depends only on standard DOM APIs
and chrome extension APIs.

## Permissions

| Permission        | Why                                                                             |
| ----------------- | ------------------------------------------------------------------------------- |
| `activeTab`       | Inject the recorder into the tab you are looking at.                            |
| `scripting`       | Insert the content script that listens to DOM events.                           |
| `tabs`            | Read the current tab URL to seed the first `goto` step.                         |
| `webNavigation`   | Detect in-page navigations so multi-page flows include every `goto` step.       |
| `downloads`       | Save the recorded flow as a JSON file.                                          |
| `storage`         | Keep recording state alive when the service worker suspends.                    |
| `<all_urls>`      | Record on whichever site you choose. The extension only activates on **Start**. |

The extension never sends data off your machine. Everything stays in the
browser's session storage and is cleared on **Clear** or browser close.

## Captured interactions

| Event                                           | Emitted step                                       |
| ----------------------------------------------- | -------------------------------------------------- |
| Click on button / link / clickable element      | `{ click: "<selector>" }`                          |
| Typing into a text input                        | `{ fill: { selector, text } }` (debounced, merged) |
| `<select>` change                               | `{ select: { selector, value } }`                  |
| Checkbox / radio toggle                         | `{ check: "<selector>" }` / `{ uncheck: ... }`     |
| File upload                                     | `{ upload: { selector, files } }` (names only)     |
| Enter / Escape / arrow key presses              | `{ key: "Enter" }`                                 |
| Scroll of page or scrollable element (debounced) | `{ scroll: { selector?, x, y } }`                  |
| Page navigation                                 | `{ goto: "<url>" }`                                |

## Selector strategy

For each captured element, the recorder picks the first selector that
*uniquely* resolves in the current document:

1. `[data-testid="…"]` (or `data-test-id` / `data-test`)
2. `#id` (skipped if the id looks auto-generated)
3. `[aria-label="…"]`
4. `<tag>[name="…"]` for form controls
5. `[role="…"]` if a role is present
6. A short CSS path built from tag + stable class names + `:nth-of-type`

Auto-generated ids (uuids, emotion/mui/radix hashes, `:r1:` style) are
rejected so the selector does not break on next render.

## Export format

The exported JSON matches the uxinspect `Flow` type from `src/types.ts`:

```json
{
  "name": "Checkout happy path",
  "steps": [
    { "goto": "https://example.com/" },
    { "click": "[data-testid=\"add-to-cart\"]" },
    { "fill": { "selector": "#email", "text": "buyer@example.com" } },
    { "click": "[aria-label=\"Place order\"]" }
  ]
}
```

Drop this object into the `flows` array in your `uxinspect.config.{js,ts,json}`
and run `npx uxinspect run` — no further conversion needed.

## Known limitations

- Restricted pages (`chrome://`, `chrome-extension://`, the Chrome Web Store,
  and a few others) cannot be recorded — Chrome blocks content-script
  injection there.
- Shadow DOM and cross-origin iframes are not traversed yet; interactions
  inside them fall back to the closest host-document selector.
- Drag-and-drop is not yet emitted as `{ drag: { from, to } }`.
- Hover-only reveals (tooltips / menus) are not captured unless you click.

## File layout

```
apps/recorder-extension/
  manifest.json     MV3 manifest
  background.js     Service worker: state, navigation tracking, messaging
  content.js        In-page listener: clicks, inputs, keys, scroll, uploads
  popup.html        GCP-styled popup UI
  popup.css         Design tokens, colours, spacing
  popup.js          Start / Stop / Copy / Download wiring
  icons/            16, 32, 48, 128 PNG icons
  package.json      Metadata only (no deps, no build)
  README.md         This file
```
