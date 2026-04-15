# uxinspect for VS Code

Inline broken-interaction diagnostics + one-click replay for [uxinspect](https://uxinspect.com) flows.

## What it does

- Reads `.uxinspect/last.json` from your workspace root after every uxinspect run.
- For every broken flow, surfaces a red squiggle on the exact `name: '...'` declaration in your flow file, with the failing step summary in the Problems panel.
- Status bar shows `<passed>/<total>` for the last run. Click it to open the HTML report.
- Commands:
  - `uxinspect: Run Fast` — runs `uxinspect run --fast` in an integrated terminal.
  - `uxinspect: Open HTML Report` — opens `report/index.html` in your browser.
  - `uxinspect: Replay Failing Flow` — place cursor on a broken flow, runs `uxinspect replay <path>`.
  - `uxinspect: Refresh Diagnostics` — re-reads `last.json`.

## Install (from source)

```
cd apps/vscode-extension
npm install
npm run compile
```

Then in VS Code: `Developer: Install Extension from Location...` and point to this folder, or press `F5` from inside this directory to launch a dev host.

## Install (from marketplace)

Coming soon. Once published: search `uxinspect` in the Extensions view.

## Usage

1. Run uxinspect in your project:
   ```
   npx uxinspect run --fast
   ```
   This writes `.uxinspect/last.json` to your workspace root.
2. Open any `.ts` / `.js` file that defines your flows.
3. Broken flows appear as red squiggles on the flow `name`.
4. Hover the squiggle to see the failing step (selector + error message).
5. Place cursor on the broken flow and run `uxinspect: Replay Failing Flow` to scrub the recording.

## Configuration

| Setting                  | Default                    | Purpose                               |
| ------------------------ | -------------------------- | ------------------------------------- |
| `uxinspect.lastRunPath`  | `.uxinspect/last.json`     | Where to read the last run JSON.      |
| `uxinspect.reportPath`   | `report/index.html`        | Path opened by `Open HTML Report`.    |
| `uxinspect.flowsGlob`    | `**/*.{ts,tsx,js,jsx,mjs,cjs}` | Files scanned for flow definitions. |
| `uxinspect.cliCommand`   | `npx uxinspect`            | CLI invocation used by commands.      |

## Requirements

- VS Code `1.85+`
- Node.js `20+`
- A project that uses uxinspect and writes `.uxinspect/last.json` after each run.

## License

MIT
