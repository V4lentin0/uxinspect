import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Flow } from './types.js';
import {
  ALL_ROUTES,
  filterFlowsByRoutes,
  getChangedFiles,
  globToRegex,
  matchFilesToRoutes,
  summarizeChangedRun,
} from './git-diff-mode.js';

const execFileP = promisify(execFile);

const FLOWS: Flow[] = [
  { name: 'home', steps: [{ goto: 'https://example.com/' }] },
  { name: 'checkout', steps: [{ goto: 'https://example.com/checkout' }, { goto: 'https://example.com/checkout/confirm' }] },
  { name: 'admin', steps: [{ goto: 'https://example.com/admin/users' }] },
  { name: 'noop', steps: [{ click: '.foo' }] },
];

test('globToRegex — `**` spans directories, `*` stops at `/`', () => {
  const deep = globToRegex('src/pages/**');
  assert.equal(deep.test('src/pages/checkout/index.tsx'), true);
  assert.equal(deep.test('src/pages/checkout/confirm/page.tsx'), true);
  assert.equal(deep.test('src/other/file.tsx'), false);

  const shallow = globToRegex('src/*.ts');
  assert.equal(shallow.test('src/cli.ts'), true);
  assert.equal(shallow.test('src/a/b.ts'), false);
});

test('matchFilesToRoutes — explicit routeMap maps files to routes', () => {
  const routes = matchFilesToRoutes(
    ['src/pages/checkout/index.tsx', 'src/pages/checkout/confirm.tsx'],
    {
      'src/pages/checkout/**': ['/checkout', '/checkout/confirm'],
      'src/pages/admin/**': ['/admin/**'],
    },
  );
  assert.deepEqual(routes.sort(), ['/checkout', '/checkout/confirm'].sort());
});

test('matchFilesToRoutes — unknown file falls back to ALL_ROUTES', () => {
  const routes = matchFilesToRoutes(['README.md'], { 'src/pages/**': ['/a'] });
  assert.ok(routes.includes(ALL_ROUTES));
});

test('matchFilesToRoutes — default heuristics infer framework-style routes', () => {
  const cases: Array<[string, string]> = [
    ['app/dashboard/page.tsx', '/dashboard'],
    ['app/api/users/route.ts', '/api/users'],
    ['pages/about.tsx', '/about'],
    ['pages/blog/index.tsx', '/blog'],
    ['src/pages/settings/profile.tsx', '/settings/profile'],
    ['src/routes/reports/+page.svelte', '/reports/+page'],
    ['app/(marketing)/landing/page.tsx', '/landing'],
  ];
  for (const [file, expected] of cases) {
    const routes = matchFilesToRoutes([file]);
    assert.ok(routes.includes(expected), `expected ${expected} for ${file}, got ${JSON.stringify(routes)}`);
    assert.ok(!routes.includes(ALL_ROUTES), `${file} should match a heuristic, not fall back`);
  }
});

test('matchFilesToRoutes — no matching heuristic returns wildcard', () => {
  const routes = matchFilesToRoutes(['lib/util.ts', 'Dockerfile']);
  assert.deepEqual(routes, [ALL_ROUTES]);
});

test('filterFlowsByRoutes — keeps flows whose goto URLs match (plus goto-less safe default)', () => {
  const kept = filterFlowsByRoutes(FLOWS, ['/checkout']);
  assert.deepEqual(kept.map((f) => f.name).sort(), ['checkout', 'noop'].sort());
});

test('filterFlowsByRoutes — glob pattern scopes correctly', () => {
  const kept = filterFlowsByRoutes(FLOWS, ['/admin/**']);
  assert.deepEqual(kept.map((f) => f.name).sort(), ['admin', 'noop'].sort());
});

test('filterFlowsByRoutes — ALL_ROUTES wildcard returns everything', () => {
  const kept = filterFlowsByRoutes(FLOWS, [ALL_ROUTES]);
  assert.equal(kept.length, FLOWS.length);
});

test('filterFlowsByRoutes — empty route list returns all flows (safe default)', () => {
  const kept = filterFlowsByRoutes(FLOWS, []);
  assert.equal(kept.length, FLOWS.length);
});

test('filterFlowsByRoutes — flow with no goto steps is preserved', () => {
  const kept = filterFlowsByRoutes(FLOWS, ['/checkout']);
  // 'noop' has no goto; it should still be filtered OUT because we filter
  // only when urls.length > 0. Let's specifically test behaviour.
  assert.equal(kept.some((f) => f.name === 'noop'), true, 'noop kept as safe default');
});

test('filterFlowsByRoutes — relative paths also match', () => {
  const flows: Flow[] = [{ name: 'rel', steps: [{ goto: '/checkout' }] }];
  const kept = filterFlowsByRoutes(flows, ['/checkout']);
  assert.equal(kept.length, 1);
});

test('filterFlowsByRoutes — path prefix matching (non-glob)', () => {
  const flows: Flow[] = [{ name: 'deep', steps: [{ goto: 'https://x/checkout/step/1' }] }];
  const kept = filterFlowsByRoutes(flows, ['/checkout']);
  assert.equal(kept.length, 1);
});

test('summarizeChangedRun formats the kept/skipped counts', () => {
  assert.equal(summarizeChangedRun(3, 12), 'Running 3 of 12 flows (9 skipped via --changed)');
  assert.equal(summarizeChangedRun(0, 5), 'Running 0 of 5 flows (5 skipped via --changed)');
});

test('getChangedFiles spawns real git and returns changed files from HEAD~1', async () => {
  // Create a throwaway git repo, make two commits, check that the second
  // commit's changes appear in the diff against HEAD~1.
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-gitdiff-'));
  try {
    const run = (args: string[]) =>
      execFileP('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x' } });
    await run(['init', '--quiet', '-b', 'main']);
    await run(['config', 'user.email', 'x@x']);
    await run(['config', 'user.name', 'x']);
    await fs.writeFile(path.join(repo, 'a.txt'), 'one');
    await run(['add', '.']);
    await run(['commit', '-m', 'initial', '--quiet']);
    await fs.writeFile(path.join(repo, 'src/pages/checkout/index.tsx'.replace(/\//g, path.sep)), 'x').catch(async () => {
      await fs.mkdir(path.join(repo, 'src', 'pages', 'checkout'), { recursive: true });
      await fs.writeFile(path.join(repo, 'src', 'pages', 'checkout', 'index.tsx'), 'x');
    });
    await fs.writeFile(path.join(repo, 'b.txt'), 'two');
    await run(['add', '.']);
    await run(['commit', '-m', 'second', '--quiet']);

    const files = await getChangedFiles('HEAD~1', repo);
    assert.ok(files.includes('b.txt'), `expected b.txt, got ${JSON.stringify(files)}`);
    assert.ok(files.some((f) => f.endsWith('index.tsx')), `expected checkout file, got ${JSON.stringify(files)}`);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('getChangedFiles rejects on invalid ref', async () => {
  await assert.rejects(
    () => getChangedFiles('not-a-real-ref-xyzzy-12345'),
    /git diff failed/,
  );
});
