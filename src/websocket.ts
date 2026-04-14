// WebSocket flow runner for uxinspect.
//
// Uses the global `WebSocket` constructor, which is available natively in
// Node.js >= 22 (stable since 22.4 — the `--experimental-websocket` flag was
// removed there). If the global is missing (older Node, or environments that
// stripped it), `runWebSocketFlow` throws an informative error rather than
// silently failing. No `ws` npm dependency is used.

export interface WsFlow {
  name: string;
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
  steps: WsStep[];
}

export type WsStep =
  | { send: string | object }
  | { expect: { messageContains?: string; jsonPath?: { path: string; equals?: unknown } } }
  | { wait: number }
  | { close: true };

export interface WsFlowResult {
  name: string;
  url: string;
  passed: boolean;
  connected: boolean;
  messagesSent: number;
  messagesReceived: number;
  durationMs: number;
  error?: string;
  log: { ts: number; dir: 'in' | 'out' | 'system'; data: string }[];
}

// Minimal structural type for the native WebSocket we consume. Keeps this file
// free of DOM lib deps while letting strict TS check us.
interface NativeWebSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'error', listener: (ev: unknown) => void): void;
  addEventListener(type: 'close', listener: (ev: { code?: number; reason?: string }) => void): void;
}

type NativeWebSocketCtor = new (
  url: string,
  protocolsOrOptions?: string | string[] | { headers?: Record<string, string> },
) => NativeWebSocket;

const OPEN_STATE = 1;

export async function runWebSocketFlow(flow: WsFlow): Promise<WsFlowResult> {
  const startedAt = Date.now();
  const log: WsFlowResult['log'] = [];
  const append = (dir: 'in' | 'out' | 'system', data: string) =>
    log.push({ ts: Date.now(), dir, data });

  const result: WsFlowResult = {
    name: flow.name,
    url: flow.url,
    passed: false,
    connected: false,
    messagesSent: 0,
    messagesReceived: 0,
    durationMs: 0,
    log,
  };

  const Ctor = (globalThis as { WebSocket?: NativeWebSocketCtor }).WebSocket;
  if (typeof Ctor !== 'function') {
    result.error =
      'global WebSocket is not available — requires Node.js >= 22 (stable since 22.4, no flag needed)';
    result.durationMs = Date.now() - startedAt;
    append('system', result.error);
    return result;
  }

  const timeoutMs = flow.timeout ?? 10000;

  // Pending-message machinery: `expect` steps wait on the next unread message.
  const incoming: string[] = [];
  let waiter: ((msg: string) => void) | null = null;
  let socketClosed = false;
  const closeInfo: { code?: number; reason?: string } = {};
  let sawClose = false;
  let socketError: string | null = null;

  const pushMessage = (data: string) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(data);
    } else {
      incoming.push(data);
    }
  };

  // Construct socket — some Node versions accept `{ headers }` as the second
  // arg, others ignore it. We pass headers when provided; if unsupported this
  // is a silent no-op on the handshake which is the documented native behavior.
  let ws: NativeWebSocket;
  try {
    ws = flow.headers
      ? new Ctor(flow.url, { headers: flow.headers })
      : new Ctor(flow.url);
  } catch (e) {
    result.error = `failed to construct WebSocket: ${errMsg(e)}`;
    result.durationMs = Date.now() - startedAt;
    append('system', result.error);
    return result;
  }

  const openPromise = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => {
      result.connected = true;
      append('system', `open ${flow.url}`);
      resolve();
    });
    ws.addEventListener('error', (ev) => {
      const msg = `ws error: ${errMsg(ev)}`;
      socketError = socketError ?? msg;
      append('system', msg);
      reject(new Error(msg));
    });
  });

  ws.addEventListener('message', (ev) => {
    const data = typeof ev.data === 'string' ? ev.data : bufferLikeToString(ev.data);
    result.messagesReceived += 1;
    append('in', data);
    pushMessage(data);
  });

  ws.addEventListener('close', (ev) => {
    socketClosed = true;
    sawClose = true;
    closeInfo.code = ev.code;
    closeInfo.reason = ev.reason;
    append('system', `close code=${ev.code ?? ''} reason=${ev.reason ?? ''}`);
    if (waiter) {
      const w = waiter;
      waiter = null;
      w('__WS_CLOSED__');
    }
  });

  const flowPromise = (async () => {
    await openPromise;

    for (const step of flow.steps) {
      if ('send' in step) {
        if (socketClosed || ws.readyState !== OPEN_STATE) {
          throw new Error('cannot send: socket is not open');
        }
        const payload =
          typeof step.send === 'string' ? step.send : JSON.stringify(step.send);
        ws.send(payload);
        result.messagesSent += 1;
        append('out', payload);
      } else if ('expect' in step) {
        const msg = await nextMessage();
        if (msg === '__WS_CLOSED__') {
          throw new Error('socket closed before expected message arrived');
        }
        const e = step.expect;
        if (e.messageContains !== undefined && !msg.includes(e.messageContains)) {
          throw new Error(`message missing substring: ${e.messageContains}`);
        }
        if (e.jsonPath) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(msg);
          } catch {
            throw new Error(`jsonPath ${e.jsonPath.path}: message is not JSON`);
          }
          const val = getPath(parsed, e.jsonPath.path);
          if (
            e.jsonPath.equals !== undefined &&
            JSON.stringify(val) !== JSON.stringify(e.jsonPath.equals)
          ) {
            throw new Error(
              `jsonPath ${e.jsonPath.path}: ${JSON.stringify(val)} !== ${JSON.stringify(e.jsonPath.equals)}`,
            );
          }
        }
      } else if ('wait' in step) {
        await delay(step.wait);
      } else if ('close' in step && step.close) {
        ws.close();
        // Give the close event a brief tick to settle.
        await delay(10);
      }
    }
  })();

  function nextMessage(): Promise<string> {
    if (incoming.length > 0) {
      return Promise.resolve(incoming.shift() as string);
    }
    if (socketClosed) {
      return Promise.resolve('__WS_CLOSED__');
    }
    return new Promise<string>((resolve) => {
      waiter = resolve;
    });
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`flow timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([flowPromise, timeoutPromise]);
    result.passed = true;
  } catch (e) {
    result.passed = false;
    result.error = socketError ?? errMsg(e);
    append('system', `fail: ${result.error}`);
  } finally {
    if (timer) clearTimeout(timer);
    if (!socketClosed && ws.readyState === OPEN_STATE) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    result.durationMs = Date.now() - startedAt;
    if (sawClose && !result.error && !result.passed) {
      result.error = `closed before flow finished (code=${closeInfo.code ?? ''})`;
    }
  }

  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function bufferLikeToString(data: unknown): string {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new TextDecoder().decode(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    );
  }
  try {
    return String(data);
  } catch {
    return '';
  }
}

function getPath(obj: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
