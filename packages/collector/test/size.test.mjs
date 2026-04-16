// Hard guard: the gzipped collector must stay under 5KB. Bumping this
// threshold is a decision that needs to happen in package.json AND here
// — if you're here to raise the budget, get product sign-off first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";

const BUDGET = 5 * 1024;
const MIN_PATH = resolve("dist/collector.min.js");

test("dist/collector.min.js exists (run `npm run build`)", () => {
  assert.ok(existsSync(MIN_PATH), "build artefact missing");
});

test("gzipped size is under 5KB budget", () => {
  const bytes = readFileSync(MIN_PATH);
  const gz = gzipSync(bytes);
  console.log(`  minified=${bytes.length}B gzipped=${gz.length}B budget=${BUDGET}B`);
  assert.ok(gz.length < BUDGET, `gzipped size ${gz.length}B >= ${BUDGET}B budget`);
});

test("minified bundle is non-empty and an IIFE", () => {
  const src = readFileSync(MIN_PATH, "utf8");
  assert.ok(src.length > 100);
  // IIFE output from esbuild starts with `var uxi=` or `(()=>` depending on globalName.
  assert.ok(/var\s+uxi\s*=|\(\s*\(\s*\)\s*=>/.test(src), "bundle should be an IIFE");
});
