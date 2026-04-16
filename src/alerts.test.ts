/**
 * P5 #43 — alerts rendering + Telegram transport tests.
 *
 * Existing Slack/Discord/Teams renderers are exercised here (they were
 * previously untested) plus the new Telegram renderer + sendTelegram.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderSlackAlert,
  renderDiscordAlert,
  renderTeamsAlert,
  renderTelegramAlert,
  sendAlert,
  sendTelegram,
} from './alerts.js';

const baseResult = {
  url: 'https://example.com',
  startedAt: '2026-04-17T00:00:00.000Z',
  durationMs: 1234,
  flows: [
    { name: 'checkout', passed: false, error: 'button not found' },
    { name: 'login', passed: true },
  ],
};

test('renderSlackAlert: includes status, failed flows, and action buttons', () => {
  const blocks = renderSlackAlert(baseResult, { newFailures: 1 }, {
    repo: 'nis/swiftguest',
    branch: 'main',
    reportUrl: 'https://r/1',
    replayUrl: 'https://r/2',
  });
  const flat = JSON.stringify(blocks);
  assert.match(flat, /\*FAIL\*/);
  assert.match(flat, /example\.com/);
  assert.match(flat, /checkout: button not found/);
  assert.match(flat, /View Report/);
  assert.match(flat, /View Replay/);
  assert.match(flat, /nis\/swiftguest/);
});

test('renderDiscordAlert: sets red colour on fail + fields on pass', () => {
  const fail = renderDiscordAlert(baseResult);
  assert.equal(fail.title, 'FAIL');
  assert.equal(fail.color, parseInt('EF4444', 16));

  const pass = renderDiscordAlert({ ...baseResult, flows: [{ name: 'ok', passed: true }] });
  assert.equal(pass.title, 'PASS');
  assert.equal(pass.color, parseInt('10B981', 16));
});

test('renderTeamsAlert: AdaptiveCard with Attention colour + failed flow list', () => {
  const card = renderTeamsAlert(baseResult) as Record<string, any>;
  assert.equal(card.type, 'AdaptiveCard');
  const body = JSON.stringify(card.body);
  assert.match(body, /Attention/);
  assert.match(body, /checkout: button not found/);
});

test('renderTelegramAlert: MarkdownV2 body with escaped punctuation and status', () => {
  const p = renderTelegramAlert(baseResult, { newFailures: 1 }, { repo: 'nis/app' }, 12345);
  assert.equal(p.parse_mode, 'MarkdownV2');
  assert.equal(p.chat_id, 12345);
  assert.equal(p.disable_web_page_preview, true);
  const text = p.text as string;
  assert.match(text, /\*FAIL\*/);
  // `.` inside example.com must be escaped (`\.`).
  assert.match(text, /example\\\.com/);
  assert.match(text, /new failures/);
  assert.match(text, /• checkout/);
});

test('renderTelegramAlert: escapes reserved MarkdownV2 chars in flow error', () => {
  const p = renderTelegramAlert({
    ...baseResult,
    flows: [{ name: 'pay (A)', passed: false, error: 'x_y.z!' }],
  });
  const text = p.text as string;
  // Each reserved char must be prefixed with `\`.
  assert.match(text, /pay \\\(A\\\)/);
  assert.match(text, /x\\_y\\\.z\\!/);
});

test('renderTelegramAlert: omits chat_id when not supplied', () => {
  const p = renderTelegramAlert(baseResult);
  assert.ok(!('chat_id' in p));
});

test('renderTelegramAlert: appends report + replay links when provided', () => {
  const p = renderTelegramAlert(baseResult, undefined, {
    reportUrl: 'https://r/1',
    replayUrl: 'https://r/2',
  });
  const text = p.text as string;
  assert.match(text, /\[report\]\(https:\/\/r\/1\)/);
  assert.match(text, /\[replay\]\(https:\/\/r\/2\)/);
});

test('sendAlert(telegram): POSTs raw payload JSON (not wrapped)', async () => {
  let captured: { url?: string; body?: string } = {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    captured = { url: String(url), body: init?.body as string };
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
  try {
    const ok = await sendAlert('https://api.telegram.org/botX/sendMessage', 'telegram', {
      text: 'hi',
      parse_mode: 'MarkdownV2',
    });
    assert.equal(ok, true);
    assert.match(captured.url!, /api\.telegram\.org/);
    const body = JSON.parse(captured.body!);
    assert.equal(body.text, 'hi');
    assert.equal(body.parse_mode, 'MarkdownV2');
    // Must not wrap in blocks/embeds/attachments.
    assert.ok(!('blocks' in body));
    assert.ok(!('embeds' in body));
    assert.ok(!('attachments' in body));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sendTelegram: builds correct bot URL and returns fetch.ok', async () => {
  let capturedUrl = '';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    capturedUrl = String(url);
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
  try {
    const ok = await sendTelegram('123:abc', 42, baseResult);
    assert.equal(ok, true);
    assert.equal(
      capturedUrl,
      'https://api.telegram.org/bot123%3Aabc/sendMessage',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sendAlert: returns false on network error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  try {
    const ok = await sendAlert('https://dead.example', 'slack', []);
    assert.equal(ok, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
