import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import {
  extractFromPage,
  defineSchemas,
  describeSchema,
  heuristicExtractField,
} from './extract.js';

let browser: Browser | undefined;
let context: BrowserContext | undefined;

before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
});

after(async () => {
  await context?.close();
  await browser?.close();
});

async function newPage(): Promise<Page> {
  if (!context) throw new Error('browser context not ready');
  return context.newPage();
}

describe('describeSchema', () => {
  test('flattens a ZodObject into field descriptors with kind inference', () => {
    const schema = z.object({
      email: z.string().email(),
      phone: z.string(),
      website: z.string().url(),
      price: z.number(),
      hired: z.boolean(),
      name: z.string().optional(),
    });
    const desc = describeSchema(schema);
    const byKey = Object.fromEntries(desc.map((d) => [d.key, d]));
    assert.equal(byKey.email.kind, 'email');
    assert.equal(byKey.phone.kind, 'phone');
    assert.equal(byKey.website.kind, 'url');
    assert.equal(byKey.price.kind, 'money');
    assert.equal(byKey.hired.kind, 'boolean');
    assert.equal(byKey.name.kind, 'string');
    assert.equal(byKey.name.optional, true);
    assert.equal(byKey.email.optional, false);
  });

  test('handles single non-object schema by wrapping under "value"', () => {
    const desc = describeSchema(z.string().email());
    assert.equal(desc.length, 1);
    assert.equal(desc[0].key, 'value');
    assert.equal(desc[0].kind, 'email');
  });
});

describe('heuristicExtractField', () => {
  test('extracts email via regex', () => {
    const hit = heuristicExtractField('Reach us: hello@uxinspect.com anytime.', {
      key: 'email',
      kind: 'email',
      optional: false,
    });
    assert.ok(hit);
    assert.equal(hit!.value, 'hello@uxinspect.com');
    assert.ok(hit!.confidence >= 0.8);
  });

  test('extracts labeled string value', () => {
    const hit = heuristicExtractField('Title: Widget Pro Max\nCategory: Tools', {
      key: 'title',
      kind: 'string',
      optional: false,
    });
    assert.ok(hit);
    assert.equal(hit!.value, 'Widget Pro Max');
  });

  test('extracts number', () => {
    const hit = heuristicExtractField('Count: 42 items.', {
      key: 'count',
      kind: 'number',
      optional: false,
    });
    assert.ok(hit);
    assert.equal(hit!.value, 42);
  });

  test('returns null when required field missing', () => {
    const hit = heuristicExtractField('No relevant data here.', {
      key: 'email',
      kind: 'email',
      optional: false,
    });
    assert.equal(hit, null);
  });
});

describe('extractFromPage — heuristic path', () => {
  test('pulls email from contact page via regex', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><body>
          <h1>Contact us</h1>
          <p>Email: support@uxinspect.com</p>
          <p>Phone: +1 415-555-0199</p>
        </body></html>
      `);
      const schema = z.object({ email: z.string().email() });
      const result = await extractFromPage(page, 'Find the contact email', schema);
      assert.equal(result.source, 'heuristic');
      assert.equal(result.data.email, 'support@uxinspect.com');
      assert.ok(result.confidence > 0.5);
    } finally {
      await page.close();
    }
  });

  test('pulls multi-field record from page text', async () => {
    const page = await newPage();
    try {
      await page.setContent(`
        <html><body>
          <section>
            <p>Email: ceo@uxinspect.com</p>
            <p>Phone: +1 415 555 1234</p>
            <p>Website: https://uxinspect.com</p>
          </section>
        </body></html>
      `);
      const schema = z.object({
        email: z.string().email(),
        phone: z.string(),
        website: z.string().url(),
      });
      const result = await extractFromPage(page, 'Extract contact block', schema);
      assert.equal(result.source, 'heuristic');
      assert.equal(result.data.email, 'ceo@uxinspect.com');
      assert.ok(result.data.phone.includes('415'));
      assert.equal(result.data.website, 'https://uxinspect.com');
    } finally {
      await page.close();
    }
  });

  test('throws when heuristic fails and Ollama disabled', async () => {
    const page = await newPage();
    try {
      await page.setContent('<html><body><p>Nothing structured here.</p></body></html>');
      const schema = z.object({ email: z.string().email() });
      await assert.rejects(
        () => extractFromPage(page, 'Find the email', schema),
        /heuristic extraction failed/i,
      );
    } finally {
      await page.close();
    }
  });
});

describe('extractFromPage — LLM fallback (mocked)', () => {
  test('falls back to Ollama when heuristic fails; validates via Zod', async () => {
    const page = await newPage();
    try {
      // Page has price buried in JS so visible text lacks a labeled "price".
      await page.setContent(`
        <html><body>
          <div>Gadget 3000 — the best gadget ever. Buy now!</div>
          <div class="cost-display">$129.99</div>
        </body></html>
      `);
      const schema = z.object({ name: z.string(), price: z.number() });

      // Mock fetch to simulate Ollama
      let calledUrl = '';
      let calledBody: any = null;
      const mockFetch: typeof fetch = (async (input: any, init?: any) => {
        calledUrl = String(input);
        calledBody = init?.body ? JSON.parse(init.body) : null;
        const payload = { name: 'Gadget 3000', price: 129.99 };
        return new Response(JSON.stringify({ response: JSON.stringify(payload) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as any;

      const result = await extractFromPage(page, 'Extract product name and price', schema, {
        ollamaEnabled: true,
        ollamaUrl: 'http://fake-ollama:11434',
        ollamaModel: 'llama3',
        fetchImpl: mockFetch,
      });

      assert.equal(result.source, 'llm');
      assert.equal(result.data.name, 'Gadget 3000');
      assert.equal(result.data.price, 129.99);
      assert.ok(calledUrl.includes('/api/generate'));
      assert.equal(calledBody.model, 'llama3');
      assert.ok(calledBody.prompt.includes('Extract product name and price'));
    } finally {
      await page.close();
    }
  });

  test('throws with helpful error when Ollama response fails schema', async () => {
    const page = await newPage();
    try {
      await page.setContent('<html><body><p>No price here.</p></body></html>');
      const schema = z.object({ price: z.number() });
      const mockFetch: typeof fetch = (async () => {
        return new Response(JSON.stringify({ response: JSON.stringify({ price: 'not-a-number' }) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as any;
      await assert.rejects(
        () =>
          extractFromPage(page, 'Get price', schema, {
            ollamaEnabled: true,
            fetchImpl: mockFetch,
          }),
        /did not match schema/i,
      );
    } finally {
      await page.close();
    }
  });

  test('throws when Ollama returns HTTP error', async () => {
    const page = await newPage();
    try {
      await page.setContent('<html><body><p>nothing.</p></body></html>');
      const schema = z.object({ price: z.number() });
      const mockFetch: typeof fetch = (async () => new Response('gateway error', { status: 503 })) as any;
      await assert.rejects(
        () =>
          extractFromPage(page, 'Get price', schema, {
            ollamaEnabled: true,
            fetchImpl: mockFetch,
          }),
        /Ollama fallback failed/i,
      );
    } finally {
      await page.close();
    }
  });
});

describe('defineSchemas', () => {
  test('returns registry unchanged (identity) for runtime use', () => {
    const registry = defineSchemas({
      contact: z.object({ email: z.string().email() }),
      product: z.object({ name: z.string(), price: z.number() }),
    });
    assert.ok(registry.contact);
    assert.ok(registry.product);
    // Round-trip through schema
    const parsed = registry.contact.safeParse({ email: 'a@b.com' });
    assert.equal(parsed.success, true);
  });
});
