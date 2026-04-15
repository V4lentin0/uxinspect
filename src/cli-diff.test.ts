import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { saveLastRun } from './index.js';
import type { InspectResult } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Compiled test lives in dist/, so the CLI is a sibling: dist/cli.js
const CLI = path.join(__dirname, 'cli.js');

function baseResult(overrides: Partial<InspectResult> = {}): InspectResult {
  const base: InspectResult = {
    url: 'https://example.com',
    startedAt: '2026-04-14T00:00:00.000Z',
    finishedAt: '2026-04-14T00:00:01.000Z',
    durationMs: 1000,
    flows: [{ name: 'load', passed: true, steps: [], screenshots: [] }],
    perf: [
      {
        page: 'https://example.com',
        scores: { performance: 95, accessibility: 95, bestPractices: 95, seo: 95 },
        metrics: { lcp: 1500, cls: 0.01, tbt: 50, fcp: 800, si: 1000, tti: 1500 },
      } as any,
    ],
    passed: true,
  };
  return { ...base, ...overrides };
}

function regressedResult(): InspectResult {
  const r = baseResult();
  r.perf = [
    {
      page: 'https://example.com',
      scores: { performance: 60, accessibility: 95, bestPractices: 95, seo: 95 },
      metrics: { lcp: 5000, cls: 0.3, tbt: 500, fcp: 800, si: 1000, tti: 1500 },
    } as any,
  ];
  return r;
}

interface RunOut {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): Promise<RunOut> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b) => { stdout += String(b); });
    proc.stderr.on('data', (b) => { stderr += String(b); });
    proc.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

test('saveLastRun writes .uxinspect/last.json to given cwd', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-last-'));
  try {
    const p = await saveLastRun(baseResult(), dir);
    assert.equal(p, path.join(dir, '.uxinspect', 'last.json'));
    const text = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(text);
    assert.equal(parsed.url, 'https://example.com');
    assert.equal(parsed.passed, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('uxinspect diff dispatches and exits 0 when no regressions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-diff-'));
  try {
    const basePath = path.join(dir, 'baseline.json');
    const curPath = path.join(dir, 'current.json');
    await fs.writeFile(basePath, JSON.stringify(baseResult()));
    await fs.writeFile(curPath, JSON.stringify(baseResult()));

    const out = await runCli(['diff', basePath, curPath], dir);
    assert.equal(out.code, 0, `expected 0 exit, got ${out.code}. stderr=${out.stderr}`);
    assert.match(out.stdout, /Budget Diff: PASS/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('uxinspect diff exits 1 when regressions detected', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-diff-'));
  try {
    const basePath = path.join(dir, 'baseline.json');
    const curPath = path.join(dir, 'current.json');
    await fs.writeFile(basePath, JSON.stringify(baseResult()));
    await fs.writeFile(curPath, JSON.stringify(regressedResult()));

    const out = await runCli(['diff', basePath, curPath], dir);
    assert.equal(out.code, 1, `expected 1 exit on regression, got ${out.code}`);
    assert.match(out.stdout, /Budget Diff: FAIL/);
    assert.match(out.stdout, /REGRESSED/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('uxinspect diff defaults current to .uxinspect/last.json', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-diff-'));
  try {
    const basePath = path.join(dir, 'baseline.json');
    await fs.writeFile(basePath, JSON.stringify(baseResult()));
    // Create auto-baseline via exported helper
    await saveLastRun(baseResult(), dir);

    const out = await runCli(['diff', basePath], dir);
    assert.equal(out.code, 0, `expected 0 exit with auto last.json, got ${out.code}. stderr=${out.stderr}`);
    assert.match(out.stdout, /Budget Diff: PASS/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('uxinspect diff errors when .uxinspect/last.json is missing and no current arg', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-diff-'));
  try {
    const basePath = path.join(dir, 'baseline.json');
    await fs.writeFile(basePath, JSON.stringify(baseResult()));

    const out = await runCli(['diff', basePath], dir);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /Current report not found/);
    assert.match(out.stderr, /last\.json/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('uxinspect diff --reporter json writes JSON output file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-diff-'));
  try {
    const basePath = path.join(dir, 'baseline.json');
    const curPath = path.join(dir, 'current.json');
    const outPath = path.join(dir, 'nested', 'diff.json');
    await fs.writeFile(basePath, JSON.stringify(baseResult()));
    await fs.writeFile(curPath, JSON.stringify(baseResult()));

    const out = await runCli(
      ['diff', basePath, curPath, '--reporter', 'json', '--out', outPath],
      dir,
    );
    assert.equal(out.code, 0, `stderr=${out.stderr}`);
    const written = JSON.parse(await fs.readFile(outPath, 'utf8'));
    assert.equal(written.passed, true);
    assert.ok(Array.isArray(written.deltas));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('uxinspect diff --reporter html writes HTML output file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-diff-'));
  try {
    const basePath = path.join(dir, 'baseline.json');
    const curPath = path.join(dir, 'current.json');
    const outPath = path.join(dir, 'diff.html');
    await fs.writeFile(basePath, JSON.stringify(baseResult()));
    await fs.writeFile(curPath, JSON.stringify(regressedResult()));

    const out = await runCli(
      ['diff', basePath, curPath, '--reporter', 'html', '--out', outPath],
      dir,
    );
    assert.equal(out.code, 1, 'regression should exit 1 even with html reporter');
    const html = await fs.readFile(outPath, 'utf8');
    assert.match(html, /<!doctype html>/);
    assert.match(html, /FAIL/);
    assert.match(html, /REGRESSED/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('uxinspect diff --reporter html errors without --out', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-diff-'));
  try {
    const basePath = path.join(dir, 'baseline.json');
    const curPath = path.join(dir, 'current.json');
    await fs.writeFile(basePath, JSON.stringify(baseResult()));
    await fs.writeFile(curPath, JSON.stringify(baseResult()));

    const out = await runCli(['diff', basePath, curPath, '--reporter', 'html'], dir);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /--out <path> is required/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
