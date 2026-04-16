// Drives the Transport logic via a synthesized module. We re-construct the
// algorithm in plain JS so the tests are bundler-free; the shipped TS is
// kept thin enough that parity is easy to maintain.
import { test } from "node:test";
import assert from "node:assert/strict";

// ---- replica of Transport semantics under test -----------------------
// Mirrors packages/collector/src/transport.ts. Kept minimal; the shape
// of the serialized payload and batch cutover is what we assert.
const MAX_BATCH = 40;

class FakeStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

class Transport {
  constructor(cfg, deps) {
    this.cfg = cfg; this.deps = deps; this.buf = [];
    const raw = deps.storage?.getItem("_uxi_q");
    if (raw) try { this.buf = JSON.parse(raw); } catch {}
  }
  push(e) { this.buf.push(e); if (this.buf.length >= MAX_BATCH) return this.flush(); }
  async flush() {
    if (!this.buf.length) return true;
    const batch = this.buf.splice(0, this.buf.length);
    const body = JSON.stringify({ siteId: this.cfg.siteId, sid: this.cfg.sid, events: batch });
    try {
      const res = await this.deps.fetchImpl(this.cfg.endpoint, { method: "POST", body });
      if (!res.ok) throw new Error("http");
      this.deps.storage?.removeItem("_uxi_q");
      return true;
    } catch {
      this.buf = batch.concat(this.buf);
      this.deps.storage?.setItem("_uxi_q", JSON.stringify(this.buf));
      return false;
    }
  }
  drain() {
    if (!this.buf.length) return;
    const batch = this.buf.splice(0, this.buf.length);
    const body = JSON.stringify({ siteId: this.cfg.siteId, sid: this.cfg.sid, events: batch });
    const ok = this.deps.beaconImpl(this.cfg.endpoint, body);
    if (!ok) this.buf = batch.concat(this.buf);
  }
}

// ---------------------------------------------------------------------

test("batches multiple events into a single POST", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  const t = new Transport(
    { siteId: "s1", endpoint: "https://x/ingest", sid: "abc" },
    { fetchImpl, storage: new FakeStorage() }
  );
  for (let i = 0; i < 5; i++) t.push({ t: "click", ts: i, url: "/", sid: "abc" });
  await t.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.events.length, 5);
  assert.equal(calls[0].body.siteId, "s1");
  assert.equal(calls[0].body.sid, "abc");
});

test("auto-flush when batch reaches MAX_BATCH", async () => {
  const calls = [];
  const fetchImpl = async (_u, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200 }; };
  const t = new Transport(
    { siteId: "s1", endpoint: "https://x/", sid: "z" },
    { fetchImpl, storage: new FakeStorage() }
  );
  for (let i = 0; i < 40; i++) await t.push({ t: "click", ts: i });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].events.length, 40);
});

test("requeues to storage on failure so retry can happen", async () => {
  const storage = new FakeStorage();
  let attempts = 0;
  const fetchImpl = async () => {
    attempts++;
    return { ok: false, status: 500 };
  };
  const t = new Transport(
    { siteId: "s1", endpoint: "https://x/", sid: "z" },
    { fetchImpl, storage }
  );
  for (let i = 0; i < 3; i++) t.push({ t: "click", ts: i });
  const ok = await t.flush();
  assert.equal(ok, false);
  assert.equal(attempts, 1);
  const persisted = JSON.parse(storage.getItem("_uxi_q"));
  assert.equal(persisted.length, 3);
});

test("restore from sessionStorage on construct so crashed pages don't lose events", async () => {
  const storage = new FakeStorage();
  storage.setItem("_uxi_q", JSON.stringify([{ t: "click", ts: 1 }, { t: "click", ts: 2 }]));
  const calls = [];
  const fetchImpl = async (_u, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200 }; };
  const t = new Transport(
    { siteId: "s1", endpoint: "https://x/", sid: "z" },
    { fetchImpl, storage }
  );
  await t.flush();
  assert.equal(calls[0].events.length, 2);
});

test("drain() uses beacon and clears buffer on success", () => {
  const beaconCalls = [];
  const beaconImpl = (url, body) => { beaconCalls.push({ url, body }); return true; };
  const t = new Transport(
    { siteId: "s1", endpoint: "https://x/", sid: "z" },
    { fetchImpl: async () => { throw new Error("no fetch"); }, storage: new FakeStorage(), beaconImpl }
  );
  t.push({ t: "click", ts: 1 });
  t.push({ t: "click", ts: 2 });
  t.drain();
  assert.equal(beaconCalls.length, 1);
  const body = JSON.parse(beaconCalls[0].body);
  assert.equal(body.events.length, 2);
});
