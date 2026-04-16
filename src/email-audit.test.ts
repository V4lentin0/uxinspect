import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runEmailAudit,
  applyRenderProfile,
  findRemoteImagesWithoutAlt,
} from './email-audit.js';

/**
 * Tests for P4 #42 email rendering audit.
 *
 * The rendering phase (Playwright screenshots) is skipped in these tests by
 * leaving `browser` undefined — the audit module short-circuits when no
 * browser context is available and still runs every checklist rule. A live
 * `fetchImpl` override replaces the network layer so tests are hermetic.
 */

const tempDirs: string[] = [];

after(async () => {
  await Promise.allSettled(
    tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })),
  );
});

async function mkOutDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-email-test-'));
  tempDirs.push(d);
  return d;
}

interface RawMessage {
  id: string;
  subject: string;
  from: string;
  to: string[];
  receivedAt: string;
  htmlBody?: string;
  textBody?: string;
  headers?: Record<string, string>;
  hasPlainTextAlternative?: boolean;
}

/** Build a `fetch` stub that returns the given capture-API fixture. */
function mockFetch(fixture: {
  list: RawMessage[];
  items?: Record<string, RawMessage>;
  failList?: boolean;
}): typeof fetch {
  return (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (fixture.failList) {
      return {
        ok: false,
        status: 503,
        async json() {
          return {};
        },
      } as unknown as Response;
    }
    const itemMatch = /\/([^/]+)$/.exec(new URL(url).pathname);
    const id = itemMatch ? itemMatch[1] : '';
    if (fixture.items && id in fixture.items) {
      const item = fixture.items[id];
      return {
        ok: true,
        status: 200,
        async json() {
          return item;
        },
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { messages: fixture.list };
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('findRemoteImagesWithoutAlt', () => {
  test('flags remote <img> tags without alt attributes', () => {
    const html = `
      <img src="https://cdn.example.com/logo.png">
      <img src="https://cdn.example.com/hero.jpg" alt="Hero">
      <img src="data:image/png;base64,abc" />
      <img src="cid:attachment-1" />
      <img src="/relative/only.png">
      <img src="//proto-relative.example.com/a.png">
    `;
    const missing = findRemoteImagesWithoutAlt(html);
    assert.deepEqual(
      missing.sort(),
      ['//proto-relative.example.com/a.png', 'https://cdn.example.com/logo.png'].sort(),
    );
  });

  test('returns empty array for document with only data: URIs', () => {
    const html = `<img src="data:image/gif;base64,R0lGODlh"/>`;
    assert.deepEqual(findRemoteImagesWithoutAlt(html), []);
  });
});

describe('applyRenderProfile', () => {
  test('as-sent wraps a bare fragment in <html><body>', () => {
    const out = applyRenderProfile('<p>hi</p>', undefined, 'as-sent');
    assert.match(out, /<html><body><p>hi<\/p><\/body><\/html>/);
  });

  test('style-stripped removes <style> blocks and inline style attrs', () => {
    const html = `<html><body><style>.x{color:red}</style><p style="color:red">hi</p></body></html>`;
    const out = applyRenderProfile(html, undefined, 'style-stripped');
    assert.ok(!/<style/i.test(out), 'should remove style blocks');
    assert.ok(!/style="/.test(out), 'should remove inline style attrs');
    assert.match(out, /<p>hi<\/p>/);
  });

  test('plain-text-fallback uses provided text body', () => {
    const out = applyRenderProfile('<p>HTML</p>', 'Plain text body', 'plain-text-fallback');
    assert.match(out, /Plain text body/);
    assert.ok(!/<p>HTML<\/p>/.test(out));
  });

  test('plain-text-fallback falls back to stripped HTML when no text body', () => {
    const out = applyRenderProfile(
      '<p>Hello <b>world</b></p>',
      undefined,
      'plain-text-fallback',
    );
    assert.match(out, /Hello world/);
  });
});

describe('runEmailAudit — fetch is mocked', () => {
  test('rejects when capture list endpoint is unreachable', async () => {
    const out = await mkOutDir();
    const result = await runEmailAudit({
      emailCaptureUrl: 'https://capture.example.com/messages',
      outDir: out,
      fetchImpl: mockFetch({ list: [], failList: true }),
    });
    assert.equal(result.passed, false);
    assert.equal(result.scanned, 0);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]!.type, 'capture-unreachable');
  });

  test('flags missing plain-text alternative and remote image without alt', async () => {
    const out = await mkOutDir();
    const msg: RawMessage = {
      id: 'abc123',
      subject: 'Welcome',
      from: 'noreply@example.com',
      to: ['user@example.com'],
      receivedAt: new Date().toISOString(),
      htmlBody: `<html><body><img src="https://cdn.example.com/banner.png"><p>Hi.</p></body></html>`,
      headers: { 'DKIM-Signature': 'v=1; a=rsa-sha256', 'Received-SPF': 'pass' },
    };
    const result = await runEmailAudit({
      emailCaptureUrl: 'https://capture.example.com/messages',
      outDir: out,
      skipScreenshots: true,
      fetchImpl: mockFetch({ list: [msg], items: { abc123: msg } }),
    });
    assert.equal(result.scanned, 1);
    const types = result.issues.map((i) => i.type).sort();
    assert.ok(types.includes('missing-plain-text-alternative'));
    assert.ok(types.includes('remote-image-missing-alt'));
    assert.equal(result.passed, false);
    assert.ok(!types.includes('subject-too-long'));
  });

  test('flags subject that exceeds RFC 2822 soft limit', async () => {
    const out = await mkOutDir();
    const longSubject = 'x'.repeat(90);
    const msg: RawMessage = {
      id: 'id-long',
      subject: longSubject,
      from: 'a@b.com',
      to: ['c@d.com'],
      receivedAt: new Date().toISOString(),
      htmlBody: '<p>hi</p>',
      textBody: 'hi',
      headers: {
        'Authentication-Results': 'spf=pass dkim=pass',
      },
    };
    const result = await runEmailAudit({
      emailCaptureUrl: 'https://capture.example.com/messages',
      outDir: out,
      skipScreenshots: true,
      fetchImpl: mockFetch({ list: [msg], items: { 'id-long': msg } }),
    });
    const subjectIssue = result.issues.find((i) => i.type === 'subject-too-long');
    assert.ok(subjectIssue, 'expected a subject-too-long issue');
    assert.equal(result.emails[0]!.subjectLength, 90);
    assert.equal(result.passed, false);
  });

  test('clean message passes when plain text, short subject, alt on all images, auth headers present', async () => {
    const out = await mkOutDir();
    const msg: RawMessage = {
      id: 'clean-1',
      subject: 'Your receipt',
      from: 'billing@example.com',
      to: ['user@example.com'],
      receivedAt: new Date().toISOString(),
      htmlBody: `<html><head><style>@media (prefers-color-scheme: dark) { body { background:#000; color:#fff } }</style></head><body><img src="https://cdn.example.com/logo.png" alt="Logo"><p>Thanks.</p></body></html>`,
      textBody: 'Thanks for your order.',
      headers: {
        'DKIM-Signature': 'v=1; a=rsa-sha256; d=example.com',
        'Received-SPF': 'pass (mailfrom)',
      },
    };
    const result = await runEmailAudit({
      emailCaptureUrl: 'https://capture.example.com/messages',
      outDir: out,
      skipScreenshots: true,
      fetchImpl: mockFetch({ list: [msg], items: { 'clean-1': msg } }),
    });
    assert.equal(result.scanned, 1);
    assert.equal(result.passed, true);
    assert.equal(result.emails[0]!.hasPlainTextAlternative, true);
    assert.equal(result.emails[0]!.hasDarkModeStyles, true);
    assert.equal(result.emails[0]!.hasDkim, true);
    assert.equal(result.emails[0]!.hasSpf, true);
    for (const issue of result.issues) {
      assert.notEqual(issue.type, 'missing-plain-text-alternative');
      assert.notEqual(issue.type, 'subject-too-long');
      assert.notEqual(issue.type, 'remote-image-missing-alt');
    }
  });

  test('filters by sinceTs — earlier messages are ignored', async () => {
    const out = await mkOutDir();
    const older: RawMessage = {
      id: 'old',
      subject: 'Old',
      from: 'a@b.com',
      to: ['c@d.com'],
      receivedAt: new Date('2023-01-01T00:00:00Z').toISOString(),
      htmlBody: '<p>old</p>',
      textBody: 'old',
    };
    const newer: RawMessage = {
      id: 'new',
      subject: 'New',
      from: 'a@b.com',
      to: ['c@d.com'],
      receivedAt: new Date('2030-01-01T00:00:00Z').toISOString(),
      htmlBody: '<p>new</p>',
      textBody: 'new',
    };
    const result = await runEmailAudit({
      emailCaptureUrl: 'https://capture.example.com/messages',
      outDir: out,
      skipScreenshots: true,
      sinceTs: Date.parse('2025-01-01T00:00:00Z'),
      fetchImpl: mockFetch({
        list: [older, newer],
        items: { old: older, new: newer },
      }),
    });
    assert.equal(result.scanned, 1);
    assert.equal(result.emails[0]!.id, 'new');
  });

  test('throws when emailCaptureUrl is missing', async () => {
    await assert.rejects(
      () =>
        runEmailAudit({
          // @ts-expect-error — deliberately bad input to exercise the guard
          emailCaptureUrl: undefined,
        }),
      /emailCaptureUrl is required/,
    );
  });

  test('sends Authorization header when authToken is provided', async () => {
    const out = await mkOutDir();
    const seenAuth: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers && headers['Authorization']) {
        seenAuth.push(headers['Authorization']);
      }
      void url;
      return {
        ok: true,
        status: 200,
        async json() {
          return { messages: [] };
        },
      } as unknown as Response;
    }) as unknown as typeof fetch;
    await runEmailAudit({
      emailCaptureUrl: 'https://capture.example.com/messages',
      authToken: 'secret-token',
      outDir: out,
      fetchImpl,
    });
    assert.ok(
      seenAuth.some((h) => h === 'Bearer secret-token'),
      `expected a Bearer secret-token header — saw ${JSON.stringify(seenAuth)}`,
    );
  });
});
