import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachNetworkCapture, stepLabelFor } from './network-attribution.js';
import type { Page } from 'playwright';

function makeRequest(url: string, method: string = 'GET', errText?: string): any {
  return {
    url: () => url,
    method: () => method,
    failure: () => (errText ? { errorText: errText } : null),
  };
}

function makeResponse(url: string, status: number, method: string = 'GET'): any {
  const req = makeRequest(url, method);
  return {
    url: () => url,
    status: () => status,
    statusText: () => (status === 200 ? 'OK' : status === 404 ? 'Not Found' : status === 500 ? 'Internal Server Error' : ''),
    request: () => req,
  };
}

function makePage(): { page: Page; emit: (event: string, arg: unknown) => void } {
  const ee = new EventEmitter();
  const page = {
    on: (event: string, listener: (...args: any[]) => void) => {
      ee.on(event, listener);
      return page;
    },
    off: (event: string, listener: (...args: any[]) => void) => {
      ee.off(event, listener);
      return page;
    },
    url: () => 'https://example.com',
  } as unknown as Page;
  return { page, emit: (event, arg) => ee.emit(event, arg) };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('attachNetworkCapture: classifies 2xx/3xx/4xx/5xx and failed correctly', () => {
  const { page, emit } = makePage();
  const handle = attachNetworkCapture(page);

  const req1 = makeRequest('https://example.com/ok');
  emit('request', req1);
  emit('response', { ...makeResponse('https://example.com/ok', 200), request: () => req1 });

  const req2 = makeRequest('https://example.com/redirect');
  emit('request', req2);
  emit('response', { ...makeResponse('https://example.com/redirect', 301), request: () => req2 });

  const req3 = makeRequest('https://example.com/missing');
  emit('request', req3);
  emit('response', { ...makeResponse('https://example.com/missing', 404), request: () => req3 });

  const req4 = makeRequest('https://example.com/boom');
  emit('request', req4);
  emit('response', { ...makeResponse('https://example.com/boom', 500), request: () => req4 });

  const req5 = makeRequest('https://example.com/dns-fail', 'GET', 'net::ERR_NAME_NOT_RESOLVED');
  emit('request', req5);
  emit('requestfailed', req5);

  const result = handle.result();
  assert.equal(result.count['2xx'], 1);
  assert.equal(result.count['3xx'], 1);
  assert.equal(result.count['4xx'], 1);
  assert.equal(result.count['5xx'], 1);
  assert.equal(result.count.failed, 1);
  assert.equal(result.failures.length, 3);
  const urls = result.failures.map((f) => f.url).sort();
  assert.deepEqual(urls, ['https://example.com/boom', 'https://example.com/dns-fail', 'https://example.com/missing']);
  handle.detach();
});

test('markStepStart attributes failures to the correct step window', async () => {
  const { page, emit } = makePage();
  const handle = attachNetworkCapture(page);

  // Pre-step noise (before any step starts)
  const preReq = makeRequest('https://example.com/pre');
  emit('request', preReq);
  emit('response', { ...makeResponse('https://example.com/pre', 404), request: () => preReq });

  await wait(5);

  // Step 1
  const cap1 = handle.markStepStart('click:#save');
  await wait(5);
  const s1r1 = makeRequest('https://example.com/api/save');
  emit('request', s1r1);
  emit('response', { ...makeResponse('https://example.com/api/save', 500), request: () => s1r1 });
  const s1r2 = makeRequest('https://example.com/api/ok');
  emit('request', s1r2);
  emit('response', { ...makeResponse('https://example.com/api/ok', 200), request: () => s1r2 });
  const r1 = cap1.end();
  assert.equal(r1.step, 'click:#save');
  assert.equal(r1.failures.length, 1);
  assert.equal(r1.failures[0].url, 'https://example.com/api/save');
  assert.equal(r1.failures[0].status, 500);
  assert.equal(r1.count['5xx'], 1);
  assert.equal(r1.count['2xx'], 1);

  await wait(5);

  // Step 2
  const cap2 = handle.markStepStart('click:#delete');
  await wait(5);
  const s2r1 = makeRequest('https://example.com/api/del', 'DELETE');
  emit('request', s2r1);
  emit('response', { ...makeResponse('https://example.com/api/del', 404, 'DELETE'), request: () => s2r1 });
  const s2r2 = makeRequest('https://example.com/api/x', 'GET', 'net::ERR_CONNECTION_RESET');
  emit('request', s2r2);
  emit('requestfailed', s2r2);
  const r2 = cap2.end();
  assert.equal(r2.step, 'click:#delete');
  assert.equal(r2.failures.length, 2);
  assert.equal(r2.count['4xx'], 1);
  assert.equal(r2.count.failed, 1);
  assert.equal(r2.failures.find((f) => f.url.endsWith('/x'))?.statusText, 'net::ERR_CONNECTION_RESET');

  // Step 1 failures must NOT appear in step 2 (no cross-contamination)
  assert.equal(r2.failures.find((f) => f.url.endsWith('/api/save')), undefined);

  // Session-level result still has everything
  const session = handle.result();
  assert.equal(session.failures.length, 4); // pre + step1-500 + step2-404 + step2-failed
  handle.detach();
});

test('empty step window yields zero counts and no failures', () => {
  const { page } = makePage();
  const handle = attachNetworkCapture(page);
  const cap = handle.markStepStart('noop');
  const r = cap.end();
  assert.equal(r.failures.length, 0);
  assert.equal(r.count['2xx'], 0);
  assert.equal(r.count['3xx'], 0);
  assert.equal(r.count['4xx'], 0);
  assert.equal(r.count['5xx'], 0);
  assert.equal(r.count.failed, 0);
  assert.equal(r.step, 'noop');
  handle.detach();
});

test('stepLabelFor produces readable labels for common step shapes', () => {
  assert.equal(stepLabelFor({ goto: 'https://example.com' }), 'goto:https://example.com');
  assert.equal(stepLabelFor({ click: '#btn' }), 'click:#btn');
  assert.equal(stepLabelFor({ type: { selector: '#in', text: 'hi' } }), 'type:#in');
  assert.equal(stepLabelFor({ sleep: 100 }), 'sleep:100');
  assert.equal(stepLabelFor({ reload: true }), 'reload:true');
  assert.equal(stepLabelFor({ drag: { from: '#a', to: '#b' } }), 'drag:#a');
  assert.equal(stepLabelFor(null), 'step');
});

test('NetworkFailure fields are populated', () => {
  const { page, emit } = makePage();
  const handle = attachNetworkCapture(page);
  const req = makeRequest('https://example.com/x', 'POST');
  emit('request', req);
  emit('response', { ...makeResponse('https://example.com/x', 404, 'POST'), request: () => req });
  const r = handle.result();
  assert.equal(r.failures.length, 1);
  const f = r.failures[0];
  assert.equal(f.url, 'https://example.com/x');
  assert.equal(f.status, 404);
  assert.equal(f.method, 'POST');
  assert.equal(f.statusText, 'Not Found');
  assert.equal(typeof f.durationMs, 'number');
  assert.equal(typeof f.ts, 'number');
  handle.detach();
});
