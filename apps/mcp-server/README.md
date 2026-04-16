# uxinspect-mcp

**Model Context Protocol server for uxinspect.** Lets IDE agents — Claude Code, Cursor, Copilot, Windsurf, Zed, and anything else that speaks MCP — drive uxinspect directly: run inspections, auto-explore pages, diff results, open replays, and query history.

## Install

```bash
npm install -g uxinspect-mcp
# or, once-off via npx — no global install:
npx uxinspect-mcp --help
```

Requires Node 20+. Playwright browsers (`npx playwright install chromium`) must be available in the host workspace if you use the `uxinspect_run` or `uxinspect_explore` tools.

## Transport

- **stdio** (default): standard MCP transport. Works for every client below.
- **WebSocket**: `uxinspect-mcp --ws [port]`. Binds to `127.0.0.1` only. Default port `8787`. Use this when your IDE wants a persistent connection across sub-agents.

```bash
uxinspect-mcp                 # stdio
uxinspect-mcp --ws            # ws://127.0.0.1:8787/
uxinspect-mcp --ws 9001       # ws://127.0.0.1:9001/
uxinspect-mcp --cwd /path/to/project   # override project root
```

## Exposed tools

| Tool | Purpose |
|---|---|
| `uxinspect_run` | Runs an inspection against a URL. Returns pass/fail, flow outcomes, budget violations, report paths. |
| `uxinspect_explore` | Auto-explores a URL by clicking every interactive element. Returns coverage % and heatmap hotspots. |
| `uxinspect_diff` | Compares two result JSONs and returns a regression list (failed flows, dropped scores, new a11y issues). |
| `uxinspect_replay` | Renders an rrweb replay viewer and serves it at a `http://127.0.0.1:<port>/` URL. |
| `uxinspect_history` | Reads `.uxinspect/history.db` and returns the last N runs as a trend, plus optional rolling-window anomalies. |

All tool inputs are zod-validated; all path arguments are constrained to the project's `cwd` (no traversal).

## Exposed resources

| URI | Type | Returns |
|---|---|---|
| `uxinspect://reports/latest` | `text/html` | The most recent `uxinspect-report/report.html`. |
| `uxinspect://flows` | `application/json` | List of `*.flow.{ts,js,json}` files and anything under `flows/`. |
| `uxinspect://history/recent` | `application/json` | Summary of the last 20 runs (duration, pass/fail, perf/a11y). |

## IDE configuration

### Claude Code / Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "uxinspect": {
      "command": "npx",
      "args": ["-y", "uxinspect-mcp"],
      "env": {}
    }
  }
}
```

For a workspace-pinned install:

```json
{
  "mcpServers": {
    "uxinspect": {
      "command": "node",
      "args": ["./node_modules/uxinspect-mcp/dist/index.js", "--cwd", "."],
      "cwd": "/absolute/path/to/project"
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json` (global) or `<project>/.cursor/mcp.json` (per-project):

```json
{
  "mcpServers": {
    "uxinspect": {
      "command": "npx",
      "args": ["-y", "uxinspect-mcp"]
    }
  }
}
```

For persistent WebSocket mode:

```json
{
  "mcpServers": {
    "uxinspect": {
      "url": "ws://127.0.0.1:8787/"
    }
  }
}
```

Start the server separately in a terminal: `uxinspect-mcp --ws`.

### VS Code (Copilot / generic MCP)

`.vscode/mcp.json` at the workspace root:

```json
{
  "servers": {
    "uxinspect": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "uxinspect-mcp"]
    }
  }
}
```

For WebSocket mode, Copilot also accepts:

```json
{
  "servers": {
    "uxinspect": {
      "type": "websocket",
      "url": "ws://127.0.0.1:8787/"
    }
  }
}
```

## Security

- **Path sandbox.** Every path argument resolves against `cwd` and rejects anything that escapes via `..` or an absolute route.
- **Writes confined.** Tool outputs (replay viewers, caches) land inside `<cwd>/.uxinspect/` — one directory to gitignore, no surprise files elsewhere.
- **Loopback only.** The WebSocket transport always binds to `127.0.0.1`.
- **No telemetry.** The server makes no outbound network calls on its own.

## Development

```bash
cd apps/mcp-server
npm install
npm run build
node dist/index.js --help
```

TypeScript strict mode is enabled. The server lazily imports uxinspect modules from each tool handler so `list_tools` / `list_resources` stay fast and the server boots even if a heavy dependency (Playwright, SQLite) is missing.

## License

MIT.
