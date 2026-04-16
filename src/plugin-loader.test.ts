import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  loadPluginsFull,
  listPlugins,
  installPlugin,
  removePlugin,
  DEFAULT_PLUGIN_DIR,
  type PluginDiagnostic,
} from './plugin-loader.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'uxi-plugins-'));
}

async function writePlugin(dir: string, file: string, body: string): Promise<string> {
  const full = path.resolve(dir, file);
  await fs.writeFile(full, body, 'utf8');
  return full;
}

const VALID_PLUGIN = `
export default {
  name: 'demo-plugin',
  version: '1.0.0',
  description: 'demo',
  audits: [
    {
      id: 'demo-audit',
      description: 'always clean',
      run: async () => [],
    },
  ],
  hooks: {
    onStart: () => {},
    onFinish: () => {},
  },
};
`;

const SECOND_PLUGIN = `
export default {
  name: 'other-plugin',
  audits: [{ id: 'x', run: () => [{ type: 'x', message: 'y', severity: 'warn' }] }],
};
`;

const INVALID_SHAPE = `
export default { notaname: true };
`;

const DUPLICATE_PLUGIN = `
export default { name: 'demo-plugin', audits: [] };
`;

describe('plugin-loader', () => {
  test('free plan is gated — no plugins loaded, license_gated diagnostic emitted', async () => {
    const dir = await makeTempDir();
    await writePlugin(dir, 'good.mjs', VALID_PLUGIN);
    const diagnostics: PluginDiagnostic[] = [];
    const res = await loadPluginsFull({ dir, licensePlan: 'free', diagnostics });
    assert.equal(res.plugins.length, 0);
    assert.ok(diagnostics.find((d) => d.kind === 'license_gated'));
  });

  test('pro + team plans are gated too (enterprise only)', async () => {
    const dir = await makeTempDir();
    await writePlugin(dir, 'good.mjs', VALID_PLUGIN);
    for (const plan of ['pro', 'team'] as const) {
      const res = await loadPluginsFull({ dir, licensePlan: plan });
      assert.equal(res.plugins.length, 0, `plan ${plan} should be gated`);
      assert.ok(res.diagnostics.some((d) => d.kind === 'license_gated'));
    }
  });

  test('enterprise plan loads valid plugin', async () => {
    const dir = await makeTempDir();
    await writePlugin(dir, 'good.mjs', VALID_PLUGIN);
    const res = await loadPluginsFull({ dir, licensePlan: 'enterprise' });
    assert.equal(res.plugins.length, 1);
    assert.equal(res.plugins[0].name, 'demo-plugin');
    assert.equal(res.plugins[0].audits?.length, 1);
    assert.ok(res.plugins[0].hooks?.onStart);
  });

  test('missing directory returns empty, no throw', async () => {
    const res = await loadPluginsFull({
      dir: path.join(os.tmpdir(), 'nonexistent-' + Date.now()),
      licensePlan: 'enterprise',
    });
    assert.equal(res.plugins.length, 0);
  });

  test('ignores non-js files', async () => {
    const dir = await makeTempDir();
    await writePlugin(dir, 'readme.md', '# not a plugin');
    await writePlugin(dir, 'config.json', '{}');
    const res = await loadPluginsFull({ dir, licensePlan: 'enterprise' });
    assert.equal(res.plugins.length, 0);
  });

  test('records invalid_shape diagnostic for bad export', async () => {
    const dir = await makeTempDir();
    await writePlugin(dir, 'bad.mjs', INVALID_SHAPE);
    const res = await loadPluginsFull({ dir, licensePlan: 'enterprise' });
    assert.equal(res.plugins.length, 0);
    assert.ok(res.diagnostics.find((d) => d.kind === 'invalid_shape'));
  });

  test('records load_error for plugin that throws on import', async () => {
    const dir = await makeTempDir();
    await writePlugin(dir, 'boom.mjs', 'throw new Error("boom")');
    const res = await loadPluginsFull({ dir, licensePlan: 'enterprise' });
    assert.ok(res.diagnostics.find((d) => d.kind === 'load_error'));
  });

  test('duplicate plugin name is rejected', async () => {
    const dir = await makeTempDir();
    await writePlugin(dir, 'a.mjs', VALID_PLUGIN);
    await writePlugin(dir, 'b.mjs', DUPLICATE_PLUGIN);
    const res = await loadPluginsFull({ dir, licensePlan: 'enterprise' });
    assert.equal(res.plugins.length, 1);
    assert.ok(res.diagnostics.find((d) => d.kind === 'duplicate_name'));
  });

  test('listPlugins returns gated message on free plan', async () => {
    const dir = await makeTempDir();
    await writePlugin(dir, 'good.mjs', VALID_PLUGIN);
    const out = await listPlugins({ dir, licensePlan: 'free' });
    assert.match(out, /Enterprise/);
  });

  test('listPlugins formats loaded plugins on enterprise', async () => {
    const dir = await makeTempDir();
    await writePlugin(dir, 'a.mjs', VALID_PLUGIN);
    await writePlugin(dir, 'b.mjs', SECOND_PLUGIN);
    const out = await listPlugins({ dir, licensePlan: 'enterprise' });
    assert.match(out, /Loaded 2 plugin\(s\)/);
    assert.match(out, /demo-plugin/);
    assert.match(out, /other-plugin/);
  });

  test('installPlugin copies file into plugin dir', async () => {
    const srcDir = await makeTempDir();
    const dstDir = await makeTempDir();
    const srcFile = await writePlugin(srcDir, 'myplugin.mjs', VALID_PLUGIN);
    const target = await installPlugin(srcFile, { dir: dstDir });
    const stat = await fs.stat(target);
    assert.ok(stat.isFile());
  });

  test('removePlugin deletes file matching name', async () => {
    const dir = await makeTempDir();
    await writePlugin(dir, 'demo.mjs', VALID_PLUGIN);
    const ok = await removePlugin('demo', { dir });
    assert.equal(ok, true);
    const res = await loadPluginsFull({ dir, licensePlan: 'enterprise' });
    assert.equal(res.plugins.length, 0);
  });

  test('removePlugin returns false when file absent', async () => {
    const dir = await makeTempDir();
    const ok = await removePlugin('nope', { dir });
    assert.equal(ok, false);
  });

  test('DEFAULT_PLUGIN_DIR is .uxinspect/plugins', () => {
    assert.equal(DEFAULT_PLUGIN_DIR, path.join('.uxinspect', 'plugins'));
  });
});
