/**
 * End-to-end integration tests for the CLI flags
 *   --playbook-backend-list
 *   --playbook-all-list
 *
 * Spawns the built CLI via `node dist/cli.js run ...` and asserts that the
 * listing commands (a) exit cleanly and (b) surface every expected gate name
 * in stdout so docs / help output stay in sync with the canonical playbook
 * entries.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { applyBackendPlaybookChecks } from './playbook-backend.js';

const REPO_ROOT = '/Users/nis/uxinspect';
const CLI_ENTRY = path.join(REPO_ROOT, 'dist', 'cli.js');

function runCli(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

test('--playbook-backend-list prints all 23 backend gates', () => {
  const { status, stdout, stderr } = runCli([
    'run',
    '--playbook-backend-list',
    '--url=https://example.com',
  ]);

  assert.equal(status, 0, `expected exit 0, got ${status}. stderr:\n${stderr}`);
  assert.match(stdout, /backend playbook/, 'stdout should mention "backend playbook"');
  assert.match(stdout, /23 gates/, 'stdout should mention "23 gates"');

  const expectedGates = [
    'security',
    'tls',
    'sitemap',
    'robotsAudit',
    'redirects',
    'exposedPaths',
    'mixedContent',
    'compression',
    'cacheHeaders',
    'crawl',
    'links',
    'errorPages',
    'protocols',
    'sourcemapScan',
    'sri',
    'clickjacking',
    'csrf',
    'cookieFlags',
    'emailAudit',
    'authEdge',
    'offline',
    'prerenderAudit',
  ];

  for (const gate of expectedGates) {
    assert.ok(
      stdout.includes(gate),
      `stdout missing backend gate "${gate}". Output was:\n${stdout}`,
    );
  }
});

test('--playbook-all-list prints combined map', () => {
  const { status, stdout, stderr } = runCli([
    'run',
    '--playbook-all-list',
    '--url=https://example.com',
  ]);

  assert.equal(status, 0, `expected exit 0, got ${status}. stderr:\n${stderr}`);
  assert.match(stdout, /full playbook/, 'stdout should mention "full playbook"');
  assert.ok(stdout.includes('gates'), 'stdout should contain the header "gates" token');

  // Sample of frontend-only gates that must appear in the combined map.
  const feSamples = ['a11y', 'visual', 'xss', 'clockRace', 'pseudoLocale'];
  for (const gate of feSamples) {
    assert.ok(
      stdout.includes(gate),
      `stdout missing FE gate "${gate}". Output was:\n${stdout}`,
    );
  }

  // Sample of backend-only gates that must appear in the combined map.
  const beSamples = ['tls', 'sitemap', 'security'];
  for (const gate of beSamples) {
    assert.ok(
      stdout.includes(gate),
      `stdout missing BE gate "${gate}". Output was:\n${stdout}`,
    );
  }
});

test('applyBackendPlaybookChecks(undefined) enables humanPassBackend', () => {
  const checks = applyBackendPlaybookChecks(undefined);
  assert.equal(
    checks.humanPassBackend,
    true,
    'humanPassBackend must be enabled when the playbook is applied with no caller overrides',
  );
});

// Regression guard — exercises the non-list `--playbook-backend` path and
// asserts the CLI does NOT spin up a browser when only the listing behaviour
// is exercised. Running this for real requires a live network target and a
// browser install, which would introduce flake in this integration suite, so
// we declare the skip here as a marker for follow-up work (A1/A3/A5 wave).
test.skip('--playbook-backend without --list does NOT consume browser', () => {
  // TODO: stub fetch / use the bundled fixture site from self-test, then
  // assert that no Playwright browser launch is triggered when the caller
  // only wants the backend gate set.
});
