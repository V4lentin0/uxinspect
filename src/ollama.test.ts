/**
 * P3 #27 — Unit tests for the Ollama bridge (opt-in local language model
 * fallback for fuzzy locator resolution). Uses a mocked `fetch` to avoid any
 * network calls; no real `localhost:11434` reachability is required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ollamaFallback, createOllamaHealHook } from './ai.js';

// ─── Tiny fetch mock ────────────────────────────────────────────────

type FetchMock = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function installFetch(mock: FetchMock): () => void {
  const prev = (globalThis as any).fetch;
  (globalThis as any).fetch = mock;
  return () => {
    (globalThis as any).fetch = prev;
  };
}

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

// ─── Tests ──────────────────────────────────────────────────────────

test('ollamaFallback returns a cleaned CSS selector on 200 OK', async () => {
  let capturedUrl = '';
  let capturedBody: any = null;
  const restore = installFetch(async (input, init) => {
    capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
    capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
    return jsonResponse({ response: 'button.primary' });
  });
  try {
    const sel = await ollamaFallback('click the primary button', '<button class="primary">OK</button>');
    assert.equal(sel, 'button.primary');
    assert.equal(capturedUrl, 'http://localhost:11434/api/generate');
    assert.equal(capturedBody.model, 'llama3.2');
    assert.equal(capturedBody.stream, false);
    assert.ok(capturedBody.prompt.includes('click the primary button'));
    assert.ok(capturedBody.prompt.includes('<button class="primary">OK</button>'));
  } finally {
    restore();
  }
});

test('ollamaFallback strips markdown code fences', async () => {
  const restore = installFetch(async () =>
    jsonResponse({ response: '```css\n#submit\n```' }),
  );
  try {
    const sel = await ollamaFallback('click submit', '<button id="submit">Go</button>');
    assert.equal(sel, '#submit');
  } finally {
    restore();
  }
});

test('ollamaFallback strips inline backticks', async () => {
  const restore = installFetch(async () => jsonResponse({ response: '`[data-testid="go"]`' }));
  try {
    const sel = await ollamaFallback('go', '<div data-testid="go"></div>');
    assert.equal(sel, '[data-testid="go"]');
  } finally {
    restore();
  }
});

test('ollamaFallback rejects long prose-like responses', async () => {
  const restore = installFetch(async () =>
    jsonResponse({
      response:
        'Sorry, I cannot find a selector for the requested element on the provided page because the button does not exist.',
    }),
  );
  try {
    const sel = await ollamaFallback('missing button', '<body></body>');
    assert.equal(sel, null);
  } finally {
    restore();
  }
});

test('ollamaFallback returns null on non-2xx', async () => {
  const restore = installFetch(async () => new Response('err', { status: 500 }));
  try {
    const sel = await ollamaFallback('click', '<body/>');
    assert.equal(sel, null);
  } finally {
    restore();
  }
});

test('ollamaFallback returns null when fetch rejects (endpoint unreachable)', async () => {
  const restore = installFetch(async () => {
    throw new Error('ECONNREFUSED');
  });
  try {
    const sel = await ollamaFallback('click', '<body/>');
    assert.equal(sel, null);
  } finally {
    restore();
  }
});

test('ollamaFallback returns null when response JSON lacks `response` field', async () => {
  const restore = installFetch(async () => jsonResponse({ foo: 'bar' }));
  try {
    const sel = await ollamaFallback('click', '<body/>');
    assert.equal(sel, null);
  } finally {
    restore();
  }
});

test('ollamaFallback honors custom model + endpoint', async () => {
  let seenUrl = '';
  let seenBody: any = null;
  const restore = installFetch(async (input, init) => {
    seenUrl = typeof input === 'string' ? input : (input as URL).toString();
    seenBody = JSON.parse(String(init?.body ?? '{}'));
    return jsonResponse({ response: 'a.link' });
  });
  try {
    const sel = await ollamaFallback('click link', '<a class="link">x</a>', {
      model: 'qwen2.5',
      endpoint: 'http://127.0.0.1:9999/api/generate',
    });
    assert.equal(sel, 'a.link');
    assert.equal(seenUrl, 'http://127.0.0.1:9999/api/generate');
    assert.equal(seenBody.model, 'qwen2.5');
  } finally {
    restore();
  }
});

test('ollamaFallback times out via AbortController', async () => {
  const restore = installFetch(async (_input, init) => {
    // Simulate a hanging request that resolves only when aborted.
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (signal) {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }
    });
  });
  try {
    const start = Date.now();
    const sel = await ollamaFallback('click', '<body/>', { timeoutMs: 50 });
    const elapsed = Date.now() - start;
    assert.equal(sel, null);
    assert.ok(elapsed < 2000, `expected fast abort, took ${elapsed}ms`);
  } finally {
    restore();
  }
});

test('ollamaFallback truncates huge DOM snippet to 3k chars', async () => {
  let seenPrompt = '';
  const restore = installFetch(async (_i, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    seenPrompt = body.prompt;
    return jsonResponse({ response: 'body' });
  });
  try {
    const huge = 'x'.repeat(10_000);
    await ollamaFallback('click body', huge);
    // Prompt contains "DOM snippet:\n" + sliced DOM. Snippet must be <= 3k.
    const dom = seenPrompt.split('DOM snippet:\n')[1] ?? '';
    assert.ok(dom.length <= 3000, `expected DOM <= 3000 chars, got ${dom.length}`);
  } finally {
    restore();
  }
});

test('createOllamaHealHook returns undefined when config is missing or disabled', () => {
  assert.equal(createOllamaHealHook(undefined), undefined);
  assert.equal(createOllamaHealHook({ enabled: false }), undefined);
  assert.equal(typeof createOllamaHealHook({ enabled: true }), 'function');
});

test('createOllamaHealHook wires model/endpoint/timeoutMs from config', async () => {
  let seen: { url: string; body: any } | null = null;
  const restore = installFetch(async (input, init) => {
    seen = {
      url: typeof input === 'string' ? input : (input as URL).toString(),
      body: JSON.parse(String(init?.body ?? '{}')),
    };
    return jsonResponse({ response: '#ok' });
  });
  try {
    const hook = createOllamaHealHook({
      enabled: true,
      model: 'custom-model',
      endpoint: 'http://127.0.0.1:12345/api/generate',
      timeoutMs: 2000,
    });
    assert.ok(hook);
    const sel = await hook!({
      instruction: 'click ok',
      target: 'ok',
      verb: 'click',
      failedSelector: 'css=.missing',
      domSnippet: '<button>OK</button>',
    });
    assert.equal(sel, '#ok');
    assert.ok(seen);
    const captured = seen as { url: string; body: any };
    assert.equal(captured.url, 'http://127.0.0.1:12345/api/generate');
    assert.equal(captured.body.model, 'custom-model');
  } finally {
    restore();
  }
});

test('createOllamaHealHook supports legacy `timeout` field', async () => {
  const restore = installFetch(async () => jsonResponse({ response: '.legacy' }));
  try {
    const hook = createOllamaHealHook({ enabled: true, timeout: 1234 });
    assert.ok(hook);
    const sel = await hook!({
      instruction: 'click legacy',
      target: 'legacy',
      verb: 'click',
      failedSelector: 'css=.gone',
      domSnippet: '<div class="legacy"/>',
    });
    assert.equal(sel, '.legacy');
  } finally {
    restore();
  }
});
