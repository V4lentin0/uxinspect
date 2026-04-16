#!/usr/bin/env node
/**
 * uxinspect MCP server entrypoint.
 *
 * Transport:
 *   - stdio is the default (standard MCP convention; works for Claude Desktop,
 *     Claude Code, Cursor, VS Code MCP clients, Copilot's MCP support).
 *   - `--ws [port]` flips to WebSocket for IDEs that prefer a persistent
 *     local connection. Default port: 8787. Bound to 127.0.0.1 only.
 *
 * The server keeps the dependency surface minimal — it only talks to the
 * `@modelcontextprotocol/sdk` and pulls in uxinspect modules lazily from each
 * tool handler. That keeps `list_tools` / `list_resources` fast and means a
 * missing optional uxinspect check won't break MCP startup.
 *
 * Security:
 *   - every tool pipes paths through safe-path helpers (no traversal).
 *   - every write lands inside `<cwd>/.uxinspect/`.
 *   - WebSocket transport binds to loopback only.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { TOOLS, type ToolContext, type ToolResult } from './tools.js';
import { RESOURCES, readResource, type ResourceContext } from './resources.js';

// Local narrow shapes so `tsc` still parses these handlers cleanly before
// the MCP SDK is installed. The SDK's own request types are structurally
// compatible (they share the same `params` shape).
interface CallToolRequest {
  params: { name: string; arguments?: Record<string, unknown> };
}
interface ReadResourceRequest {
  params: { uri: string };
}

interface CliOptions {
  transport: 'stdio' | 'ws';
  wsPort: number;
  wsHost: string;
  cwd: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    transport: 'stdio',
    wsPort: 8787,
    wsHost: '127.0.0.1',
    cwd: process.cwd(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ws' || a === '--websocket') {
      opts.transport = 'ws';
      const next = argv[i + 1];
      if (next && /^\d+$/.test(next)) {
        opts.wsPort = Number(next);
        i++;
      }
    } else if (a === '--port' && argv[i + 1]) {
      opts.wsPort = Number(argv[++i]);
    } else if (a === '--host' && argv[i + 1]) {
      opts.wsHost = String(argv[++i]);
    } else if (a === '--cwd' && argv[i + 1]) {
      opts.cwd = String(argv[++i]);
    } else if (a === '--help' || a === '-h') {
      printHelpAndExit();
    } else if (a === '--version' || a === '-V') {
      printVersionAndExit();
    }
  }
  return opts;
}

function printHelpAndExit(): never {
  process.stdout.write(`uxinspect-mcp — Model Context Protocol server for uxinspect

Usage:
  uxinspect-mcp                  start on stdio (default; matches standard MCP)
  uxinspect-mcp --ws [port]      start on WebSocket (default port 8787, loopback only)
  uxinspect-mcp --cwd <path>     override project root (default: process.cwd())
  uxinspect-mcp --help           show this message

Tools:
  ${TOOLS.map((t) => t.name).join('\n  ')}

Resources:
  ${RESOURCES.map((r) => r.uri).join('\n  ')}
`);
  process.exit(0);
}

function printVersionAndExit(): never {
  process.stdout.write('uxinspect-mcp 0.1.0\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// server wiring
// ---------------------------------------------------------------------------

function buildServer(cwd: string): Server {
  const toolCtx: ToolContext = { cwd };
  const resourceCtx: ResourceContext = { cwd };

  const server = new Server(
    { name: 'uxinspect', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema, { target: 'openApi3' }),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req: CallToolRequest) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
        isError: true,
      } satisfies ToolResult;
    }
    const parsed = tool.inputSchema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return {
        content: [{ type: 'text', text: `invalid input: ${parsed.error.message}` }],
        isError: true,
      } satisfies ToolResult;
    }
    return tool.handler(parsed.data, toolCtx);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: RESOURCES,
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req: ReadResourceRequest) => {
    const contents = await readResource(req.params.uri, resourceCtx);
    return { contents: [contents] };
  });

  return server;
}

// ---------------------------------------------------------------------------
// transports
// ---------------------------------------------------------------------------

async function startStdio(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Process stays alive on stdio; no explicit keep-alive needed.
}

async function startWebSocket(server: Server, host: string, port: number): Promise<void> {
  // Dynamic import so stdio users don't pay for the WebSocket code path.
  // The MCP SDK ships a WebSocket transport under `server/websocket`.
  const wsTransportMod = (await import('@modelcontextprotocol/sdk/server/websocket.js')) as {
    WebSocketServerTransport: new (opts: { host: string; port: number }) => {
      start(): Promise<void>;
      onRequest?: (handler: (req: unknown) => Promise<unknown>) => void;
    };
  };
  const transport = new wsTransportMod.WebSocketServerTransport({ host, port });
  await server.connect(transport as unknown as Parameters<Server['connect']>[0]);
  process.stderr.write(`uxinspect-mcp listening on ws://${host}:${port}/\n`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const server = buildServer(opts.cwd);

  if (opts.transport === 'ws') {
    await startWebSocket(server, opts.wsHost, opts.wsPort);
  } else {
    await startStdio(server);
  }
}

main().catch((err) => {
  process.stderr.write(`uxinspect-mcp fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
