// Mirrors the rateVital() thresholds from src/events.ts to guard against
// accidental regression. If these drift, update events.ts AND this file.
import { test } from "node:test";
import assert from "node:assert/strict";

function rateVital(name, v) {
  const pick = (good, poor) => (v <= good ? "good" : v <= poor ? "ni" : "poor");
  switch (name) {
    case "LCP": return pick(2500, 4000);
    case "INP": return pick(200, 500);
    case "CLS": return pick(0.1, 0.25);
    case "FCP": return pick(1800, 3000);
    case "TTFB": return pick(800, 1800);
  }
}

test("LCP thresholds per Core Web Vitals", () => {
  assert.equal(rateVital("LCP", 1000), "good");
  assert.equal(rateVital("LCP", 2500), "good");
  assert.equal(rateVital("LCP", 3500), "ni");
  assert.equal(rateVital("LCP", 5000), "poor");
});

test("INP thresholds per Core Web Vitals", () => {
  assert.equal(rateVital("INP", 50), "good");
  assert.equal(rateVital("INP", 300), "ni");
  assert.equal(rateVital("INP", 1000), "poor");
});

test("CLS thresholds", () => {
  assert.equal(rateVital("CLS", 0), "good");
  assert.equal(rateVital("CLS", 0.15), "ni");
  assert.equal(rateVital("CLS", 0.5), "poor");
});

test("FCP + TTFB thresholds", () => {
  assert.equal(rateVital("FCP", 1000), "good");
  assert.equal(rateVital("FCP", 2500), "ni");
  assert.equal(rateVital("TTFB", 500), "good");
  assert.equal(rateVital("TTFB", 1000), "ni");
  assert.equal(rateVital("TTFB", 3000), "poor");
});
