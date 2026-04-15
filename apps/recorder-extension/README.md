# uxinspect Recorder (Chrome MV3)

Record user flows in Chrome and export them as [uxinspect](https://uxinspect.com) `Step[]` code. Click around, type in fields, navigate — get a runnable `uxinspect.config.ts` back.

Version: `0.1.0` · Manifest V3 · Vanilla JS.

---

## What it captures

| Browser event | uxinspect step                         |
|---------------|----------------------------------------|
| `click`       | `{ click: '<best-selector>' }`         |
| `input`       | `{ fill: { selector, text } }`         |
| navigation    | `{ goto: url }`                        |

Consecutive keystrokes on the same field are coalesced into one `fill` with the final value. Consecutive duplicate navigations are deduped.

### Selector priority

The recorder picks the most stable selector it can find, in this order:

1. **Test IDs** — `data-testid`, `data-test`, `data-test-id`, `data-cy`, `data-qa`
2. **Role + accessible name** — `role=button[name="Save"]`
3. **Visible text** — `text="Sign in"` (short, single-line only)
4. **CSS** — `#id` → `tag.classes` → `tag[name=...]` → `nth-of-type` chain

---

## Install (load unpacked)

1. Open Chrome and go to `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked**
4. Pick the `apps/recorder-extension/` folder from this repo
5. Pin the **uxinspect Recorder** icon to the toolbar

The extension requests:

- `activeTab`, `scripting` — inject the content script on the current tab
- `storage` — persist recording state across navigations
- `downloads` — save the exported `.ts` file
- `<all_urls>` host permission — run on any site you test

It does **not** send data anywhere. Everything stays in `chrome.storage.local`.

---

## Record a flow

1. Open the page you want to test (`http(s)` only).
2. Click the extension icon → **Start**. The badge turns red (`REC`).
3. Use the page normally: click buttons, fill forms, follow links.
4. Click the extension icon → **Stop**.
5. Choose an export option:
   - **Copy as TS** — puts a flow object on your clipboard. Paste it into an existing `uxinspect.config.ts`.
   - **Download .ts** — saves a full `uxinspect.config.ts` with `defineConfig({ flows: [...] })`.

Example output:

```ts
import { defineConfig } from 'uxinspect';

export default defineConfig({
  url: 'https://app.example.com/login',
  flows: [
    {
      name: 'recorded',
      steps: [
        { "goto": "https://app.example.com/login" },
        { "fill": { "selector": "#email", "text": "user@example.com" } },
        { "fill": { "selector": "#password", "text": "s3cret" } },
        { "click": "role=button[name=\"Sign in\"]" }
      ]
    }
  ]
});
```

Run it with your existing uxinspect CLI.

---

## File layout

```
apps/recorder-extension/
  manifest.json          # MV3 manifest
  background.js          # service worker: state + message bus
  content.js             # capture-phase listeners on the page
  popup.html             # toolbar popup UI (GCP/CF tokens)
  popup.js               # popup wiring
  lib/converter.js       # events -> Step[] -> .ts (also used by tests)
  test/converter.test.js # node:test — 18 unit tests
  README.md
```

---

## Tests

```bash
cd apps/recorder-extension
node --test test/converter.test.js
```

No dependencies. Uses Node's built-in `node:test`. Covers: click / fill / goto conversion, keystroke coalescing, navigation dedupe, selector priority (testid > role+name > text > CSS), and the rendered `.ts` output.

---

## Publishing to the Chrome Web Store

Before uploading to the Web Store:

1. **Add icons.** The Web Store requires 128x128 (store listing), plus 16x16, 48x48, and 128x128 (extension). Drop PNGs into `icons/` and add this block back to `manifest.json`:

   ```json
   "action": {
     "default_icon": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
   },
   "icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
   ```

2. **Zip the folder** (exclude `test/`, `README.md`, `.DS_Store`):

   ```bash
   cd apps/recorder-extension
   zip -r ../../uxinspect-recorder-0.1.0.zip . -x "test/*" "README.md" ".DS_Store"
   ```

3. **Lint (optional but recommended):**

   ```bash
   npx --yes web-ext lint --source-dir=apps/recorder-extension
   ```

4. Upload at https://chrome.google.com/webstore/devconsole/. Fill in:
   - **Category:** Developer Tools
   - **Description:** see top of this README
   - **Privacy:** the extension does not collect, transmit, or store personal data outside of the user's local browser
   - **Host permission justification:** content script must run on any site the developer is testing
   - **Single purpose:** record user interactions and export them as uxinspect flow code

Review typically takes a few business days.

---

## Limitations (v0.1.0)

- No iframe / cross-origin frame capture (`all_frames: false`).
- No `hover`, `select`, `check`, keyboard shortcuts, or drag — v0.2 roadmap.
- No Shadow DOM-deep selectors; we pick the nearest interactive ancestor from `composedPath`.
- Navigation detection depends on `chrome.webNavigation` being available; falls back to not emitting mid-flow navigates if blocked by policy.

---

## License

MIT — same as the rest of the repo.
