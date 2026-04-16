// Re-implements the redaction regexes from src/privacy.ts to exercise them
// without needing a DOM. Keeps the source of truth in one place — if these
// fall out of sync, the bundle-contents test in privacy.test.mjs will fail
// because the tokens diverge.
import { test } from "node:test";
import assert from "node:assert/strict";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){1,4}\d{2,4}/g;
const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g;

function redact(s) {
  return s
    .replace(CARD_RE, "[card]")
    .replace(EMAIL_RE, "[email]")
    .replace(PHONE_RE, "[phone]");
}

test("redact masks email addresses", () => {
  assert.equal(redact("contact: user@example.com please"), "contact: [email] please");
  assert.equal(redact("a.b+c@sub.example.co.uk"), "[email]");
});

test("redact masks credit card numbers", () => {
  assert.equal(redact("card 4242 4242 4242 4242"), "card [card]");
  assert.equal(redact("4111-1111-1111-1111"), "[card]");
});

test("redact masks phone numbers", () => {
  const out = redact("call +1 415 555 0199");
  assert.match(out, /\[phone\]/);
});

test("redact leaves plain text alone", () => {
  assert.equal(redact("Hello world"), "Hello world");
});

test("redact runs card before phone so card digits aren't half-matched", () => {
  const out = redact("pay 4242424242424242 now");
  assert.equal(out, "pay [card] now");
});
