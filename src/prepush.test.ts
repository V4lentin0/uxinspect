import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  generatePrePushHookScript,
  installPrepush,
  uninstallPrepush,
} from './precommit.js';

async function makeRepo(): Promise<{ root: string; gitDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uxinspect-prepush-'));
  const gitDir = path.join(root, '.git');
  await fs.mkdir(path.join(gitDir, 'hooks'), { recursive: true });
  return { root, gitDir };
}

test('generatePrePushHookScript includes marker, full-audit command, shebang', () => {
  const script = generatePrePushHookScript();
  assert.match(script, /^#!\/usr\/bin\/env bash/);
  assert.match(script, /# uxinspect-managed pre-push hook/);
  assert.match(script, /npx uxinspect run --all/);
  assert.match(script, /set -e/);
});

test('generatePrePushHookScript honors custom hookCommand and timeoutS', () => {
  const script = generatePrePushHookScript({ hookCommand: 'npx uxinspect run --url https://example.com', timeoutS: 120 });
  assert.match(script, /timeout 120 npx uxinspect run --url https:\/\/example\.com/);
});

test('installPrepush writes an executable hook with uxinspect marker', async () => {
  const { root, gitDir } = await makeRepo();
  try {
    const result = await installPrepush({ gitDir, repoRoot: root });
    assert.equal(result.installed, true);
    assert.equal(result.alreadyManaged, false);
    assert.equal(result.backupPath, undefined);
    assert.equal(result.hookPath, path.join(gitDir, 'hooks', 'pre-push'));

    const contents = await fs.readFile(result.hookPath, 'utf8');
    assert.match(contents, /# uxinspect-managed pre-push hook/);
    assert.match(contents, /npx uxinspect run --all/);

    const st = await fs.stat(result.hookPath);
    assert.equal((st.mode & 0o111) !== 0, true, 'hook should be executable');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('installPrepush backs up a pre-existing non-managed hook', async () => {
  const { root, gitDir } = await makeRepo();
  try {
    const hookPath = path.join(gitDir, 'hooks', 'pre-push');
    await fs.writeFile(hookPath, '#!/bin/sh\necho existing-hook\n', { mode: 0o755 });

    const result = await installPrepush({ gitDir, repoRoot: root });
    assert.equal(result.installed, true);
    assert.ok(result.backupPath, 'expected backup path');
    const backupContents = await fs.readFile(result.backupPath!, 'utf8');
    assert.match(backupContents, /echo existing-hook/);

    const newContents = await fs.readFile(hookPath, 'utf8');
    assert.match(newContents, /# uxinspect-managed pre-push hook/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('installPrepush on pre-existing managed hook sets alreadyManaged and overwrites', async () => {
  const { root, gitDir } = await makeRepo();
  try {
    await installPrepush({ gitDir, repoRoot: root });
    const second = await installPrepush({ gitDir, repoRoot: root });
    assert.equal(second.installed, true);
    assert.equal(second.alreadyManaged, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('uninstallPrepush removes managed hook and restores backup if present', async () => {
  const { root, gitDir } = await makeRepo();
  try {
    const hookPath = path.join(gitDir, 'hooks', 'pre-push');
    const originalBody = '#!/bin/sh\necho original\n';
    await fs.writeFile(hookPath, originalBody, { mode: 0o755 });

    const install = await installPrepush({ gitDir, repoRoot: root });
    assert.equal(install.installed, true);
    assert.ok(install.backupPath);

    const un = await uninstallPrepush({ gitDir, repoRoot: root });
    assert.equal(un.removed, true);

    const restored = await fs.readFile(hookPath, 'utf8');
    assert.equal(restored, originalBody, 'backup should be restored in place');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('uninstallPrepush without prior install reports removed=false', async () => {
  const { root, gitDir } = await makeRepo();
  try {
    const un = await uninstallPrepush({ gitDir, repoRoot: root });
    assert.equal(un.removed, false);
    assert.equal(un.error, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('uninstallPrepush removes managed hook when no backup exists', async () => {
  const { root, gitDir } = await makeRepo();
  try {
    const install = await installPrepush({ gitDir, repoRoot: root });
    assert.equal(install.installed, true);
    assert.equal(install.backupPath, undefined);

    const hookPath = install.hookPath;
    assert.ok(hookPath);

    const un = await uninstallPrepush({ gitDir, repoRoot: root });
    assert.equal(un.removed, true);
    await assert.rejects(fs.stat(hookPath));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
