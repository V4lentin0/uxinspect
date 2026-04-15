import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  generateHookScript,
  installHook,
  uninstallHook,
  installPrecommit,
  uninstallPrecommit,
} from './precommit.js';

async function makeRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-hook-test-'));
  await fs.mkdir(path.join(root, '.git', 'hooks'), { recursive: true });
  return root;
}

async function rmRoot(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}

test('generateHookScript(pre-push) emits full audit + since + POSIX sh shebang', async () => {
  const script = await generateHookScript({
    hookType: 'pre-push',
    url: 'https://example.com',
    since: 'origin/HEAD',
  });
  assert.ok(script.startsWith('#!/bin/sh\n'), 'POSIX sh shebang, not bash');
  assert.ok(script.includes('# uxinspect-managed pre-push hook'), 'has pre-push marker');
  assert.ok(script.includes('--all'), 'pre-push runs full audit (--all)');
  assert.ok(script.includes('--since origin/HEAD'), 'pre-push forwards --since');
  assert.ok(script.includes('npx uxinspect run'), 'invokes uxinspect run');
  assert.ok(script.includes('pre-push check failed'), 'prints diagnostic on failure');
  // no bashisms like [[ ]], ((...)), function keyword, etc.
  assert.ok(!/\[\[/.test(script), 'no [[ ]] bashism');
  assert.ok(!/\(\(/.test(script), 'no (( )) bashism');
});

test('generateHookScript(pre-commit) keeps existing fast-subset shape with --checks', async () => {
  const script = await generateHookScript({
    hookType: 'pre-commit',
    url: 'https://example.com',
    checks: ['a11y', 'links'],
  });
  assert.ok(script.includes('# uxinspect-managed pre-commit hook'));
  assert.ok(/--checks 'a11y,links'/.test(script), 'passes --checks a11y,links (shell-quoted)');
  assert.ok(!script.includes('--all'), 'pre-commit does not force --all');
  assert.ok(!script.includes('--since'), 'pre-commit does not set --since');
});

test('generateHookScript respects --audits scope via checks on pre-push', async () => {
  const script = await generateHookScript({
    hookType: 'pre-push',
    checks: ['perf', 'a11y'],
  });
  assert.ok(/--checks 'perf,a11y'/.test(script), 'passes --checks perf,a11y (shell-quoted)');
  assert.ok(script.includes('--all'), 'still runs full when full !== false');
});

test('installHook(pre-push) writes executable script to .git/hooks/pre-push', async () => {
  const root = await makeRepo();
  try {
    const r = await installHook({ hookType: 'pre-push', repoRoot: root, url: 'https://x.test' });
    assert.equal(r.installed, true, r.error ?? '');
    assert.equal(r.hookType, 'pre-push');
    assert.equal(r.hookPath, path.join(root, '.git', 'hooks', 'pre-push'));
    const contents = await fs.readFile(r.hookPath, 'utf8');
    assert.ok(contents.startsWith('#!/bin/sh\n'));
    assert.ok(contents.includes('# uxinspect-managed pre-push hook'));
    assert.ok(contents.includes('--all'));
    const st = await fs.stat(r.hookPath);
    // chmod 0o755 — owner exec bit must be set.
    assert.ok((st.mode & 0o111) !== 0, 'hook file is executable');
  } finally {
    await rmRoot(root);
  }
});

test('installHook(pre-push) refuses to overwrite non-managed hook without force', async () => {
  const root = await makeRepo();
  try {
    const hookPath = path.join(root, '.git', 'hooks', 'pre-push');
    await fs.writeFile(hookPath, '#!/bin/sh\necho "my custom hook"\n', 'utf8');
    const r = await installHook({ hookType: 'pre-push', repoRoot: root });
    assert.equal(r.installed, false);
    assert.match(r.error ?? '', /existing hook present/);
    // original file untouched
    const after = await fs.readFile(hookPath, 'utf8');
    assert.ok(after.includes('my custom hook'));
  } finally {
    await rmRoot(root);
  }
});

test('installHook(pre-push) with force backs up existing hook before overwriting', async () => {
  const root = await makeRepo();
  try {
    const hooksDir = path.join(root, '.git', 'hooks');
    const hookPath = path.join(hooksDir, 'pre-push');
    const original = '#!/bin/sh\necho "original"\n';
    await fs.writeFile(hookPath, original, 'utf8');
    const r = await installHook({ hookType: 'pre-push', repoRoot: root, force: true });
    assert.equal(r.installed, true, r.error ?? '');
    assert.ok(r.backupPath, 'backup path returned');
    assert.ok(r.backupPath!.includes('pre-push.uxinspect-backup-'));
    const backedUp = await fs.readFile(r.backupPath!, 'utf8');
    assert.equal(backedUp, original, 'backup preserves original content');
    const managed = await fs.readFile(hookPath, 'utf8');
    assert.ok(managed.includes('# uxinspect-managed pre-push hook'));
  } finally {
    await rmRoot(root);
  }
});

test('installHook handles missing .git/ gracefully', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-nogit-'));
  try {
    const r = await installHook({ hookType: 'pre-push', repoRoot: root });
    assert.equal(r.installed, false);
    assert.match(r.error ?? '', /no \.git directory/);
  } finally {
    await rmRoot(root);
  }
});

test('uninstallHook(pre-push) removes managed hook and restores latest backup', async () => {
  const root = await makeRepo();
  try {
    const hooksDir = path.join(root, '.git', 'hooks');
    const hookPath = path.join(hooksDir, 'pre-push');
    await fs.writeFile(hookPath, '#!/bin/sh\necho "original"\n', 'utf8');
    const installed = await installHook({ hookType: 'pre-push', repoRoot: root, force: true });
    assert.equal(installed.installed, true);

    const r = await uninstallHook('pre-push', root);
    assert.equal(r.removed, true);
    // Backup was restored to hookPath
    const restored = await fs.readFile(hookPath, 'utf8');
    assert.ok(restored.includes('original'), 'latest backup restored in-place');
  } finally {
    await rmRoot(root);
  }
});

test('uninstallHook(pre-commit) and (pre-push) operate on independent hook files', async () => {
  const root = await makeRepo();
  try {
    const a = await installHook({ hookType: 'pre-commit', repoRoot: root });
    const b = await installHook({ hookType: 'pre-push', repoRoot: root });
    assert.equal(a.installed, true);
    assert.equal(b.installed, true);
    const r = await uninstallHook('pre-push', root);
    assert.equal(r.removed, true);
    // pre-commit hook must still exist
    const preCommit = await fs.readFile(path.join(root, '.git', 'hooks', 'pre-commit'), 'utf8');
    assert.ok(preCommit.includes('# uxinspect-managed pre-commit hook'));
  } finally {
    await rmRoot(root);
  }
});

test('installPrecommit + uninstallPrecommit back-compat wrappers still work', async () => {
  const root = await makeRepo();
  try {
    const r = await installPrecommit({ repoRoot: root, url: 'https://x.test' });
    assert.equal(r.installed, true);
    assert.equal(r.hookType, 'pre-commit');
    const u = await uninstallPrecommit(root);
    assert.equal(u.removed, true);
  } finally {
    await rmRoot(root);
  }
});
