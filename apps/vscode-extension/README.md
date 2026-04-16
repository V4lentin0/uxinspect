# uxinspect for VS Code

Surface broken uxinspect flows directly in the editor and jump straight to the
flow definition from the Command Palette.

## Features

- Watches `.uxinspect/last.json` in the active workspace and emits an editor
  diagnostic for every failed step of every failed flow.
- Jumps from a flow name to its definition on disk. Supports standalone flow
  files (`flows/<name>.ts|js|json`) and inline entries inside
  `uxinspect.config.ts`.
- Runs `npx uxinspect run` from the Command Palette with output streamed to a
  dedicated task terminal and the uxinspect OUTPUT panel.
- Opens the most recent HTML report, or the raw `last.json`, in one command.

The extension respects the GCP-style plain-text UI used across uxinspect: no
emojis, no custom styling, no tree views.

## Installation

### From VSIX (recommended for users)

1. Build a package with `npm install && npm run package` inside
   `apps/vscode-extension/`. This produces `uxinspect-<version>.vsix`.
2. In VS Code: **Extensions** view → three-dot menu → **Install from VSIX...**
   → select the generated file.

### From source (recommended for development)

```
cd apps/vscode-extension
npm install
npm run build
```

Then in VS Code press **F5** with this directory open — a new Extension
Development Host window launches with the extension loaded.

## Commands

All commands are published under the `uxinspect` category in the Command
Palette (`Ctrl`/`Cmd` + `Shift` + `P`).

| Command ID                 | Palette title                         | What it does                                                                 |
| -------------------------- | ------------------------------------- | ---------------------------------------------------------------------------- |
| `uxinspect.runFlows`       | uxinspect: Run Flows                  | Runs `npx uxinspect run` in a task terminal; streams output to OUTPUT panel. |
| `uxinspect.jumpToFlow`     | uxinspect: Jump to Flow Definition    | Quick-pick of flow names from the last run; opens the flow file at cursor.   |
| `uxinspect.showLastReport` | uxinspect: Show Last Report           | Opens `uxinspect-report/index.html` when present, else `.uxinspect/last.json`. |

## Settings

| Setting                     | Default                | Description                                                                         |
| --------------------------- | ---------------------- | ----------------------------------------------------------------------------------- |
| `uxinspect.flowsDir`        | `flows/`               | Folder (relative to workspace root) scanned for `<flow-name>.ts|js|json` files.     |
| `uxinspect.showDiagnostics` | `true`                 | Toggle inline diagnostics emitted from `.uxinspect/last.json`.                      |
| `uxinspect.configFile`      | `uxinspect.config.ts`  | Fallback config file to open when a flow isn't a standalone file.                   |
| `uxinspect.runCommand`      | `npx uxinspect run`    | Shell command executed by **uxinspect: Run Flows**.                                 |
| `uxinspect.lastResultFile`  | `.uxinspect/last.json` | Path watched for result changes (relative to the workspace root).                   |

## How flow location works

`uxinspect: Jump to Flow Definition` resolves a flow name in three stages:

1. If the result JSON already carries `filePath`/`line` for the flow, those
   wins.
2. Otherwise the extension looks for a standalone file in `flowsDir` — trying
   `.ts`, `.js`, `.json`, `.mjs`, and `.cjs` extensions.
3. If nothing matches, the configured config file is opened and scanned for
   `name: '<flow-name>'` — the cursor lands on the matching line.

## Diagnostics

When `.uxinspect/last.json` changes, the extension parses it and emits one
`vscode.Diagnostic` per failed step of each failed flow. The diagnostic source
is `uxinspect`, severity `Error`, and the line is the flow's starting line plus
the step index (clamped to the document length). Toggle off with
`uxinspect.showDiagnostics` when you only need jump-to-flow.

## Development

- TypeScript strict mode, no runtime dependencies other than the VS Code API.
- `npm run typecheck` — type-check only.
- `npm run build` — compile `src/` to `out/`.
- `npm run watch` — incremental build.
- `npm run package` — produce a VSIX (requires `vsce` installed globally).

## License

MIT — same as uxinspect.
