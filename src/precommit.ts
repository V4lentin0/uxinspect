import { access, chmod, constants, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';

export type HookType = 'pre-commit' | 'pre-push';

export interface HookInstallOptions {
  hookType?: HookType;
  repoRoot?: string;
  url?: string;
  configPath?: string;
  checks?: string[];
  blocking?: boolean;
  onlyIfPathsMatch?: string[];
  timeoutMs?: number;
  force?: boolean;
  /** Pre-push only. Pass `--all` to run every wired audit. Default true for pre-push. */
  full?: boolean;
  /** Pre-push only. Compare against the remote ref (e.g. `origin/HEAD`). */
  since?: string;
  /** Extra CLI flags appended verbatim to `npx uxinspect run <flags>`. */
  extraArgs?: string[];
}

// Backwards-compat alias (pre-existing name used by public API + other callers).
export type PrecommitInstallOptions = HookInstallOptions;

export interface HookInstallResult {
  installed: boolean;
  hookPath: string;
  hookType: HookType;
  backupPath?: string;
  alreadyManaged: boolean;
  error?: string;
}

export type PrecommitInstallResult = HookInstallResult;

const MARKER_PREFIX = '# uxinspect-managed';
const MARKER_SUFFIX = 'hook (do not edit this marker line)';
const BACKUP_PREFIX_BASE = 'uxinspect-backup-';

function markerFor(hookType: HookType): string {
  return `${MARKER_PREFIX} ${hookType} ${MARKER_SUFFIX}`;
}

function backupPrefixFor(hookType: HookType): string {
  return `${hookType}.${BACKUP_PREFIX_BASE}`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findGitDir(start: string): Promise<string | undefined> {
  let current = resolve(start);
  while (true) {
    const candidate = join(current, '.git');
    if (await pathExists(candidate)) {
      const st = await stat(candidate);
      if (st.isDirectory()) return candidate;
      if (st.isFile()) {
        const txt = await readFile(candidate, 'utf8');
        const m = txt.match(/^gitdir:\s*(.+)\s*$/m);
        if (m) {
          const gd = m[1];
          const resolved = gd.startsWith('/') ? gd : resolve(current, gd);
          if (await pathExists(resolved)) return resolved;
        }
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function runGit(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise) => {
    execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolvePromise('');
        return;
      }
      resolvePromise(stdout.toString().trim());
    });
  });
}

async function resolveHooksDir(repoRoot: string, gitDir: string): Promise<string> {
  const custom = await runGit(['config', '--get', 'core.hooksPath'], repoRoot, 5000);
  if (custom) {
    return custom.startsWith('/') ? custom : resolve(repoRoot, custom);
  }
  return join(gitDir, 'hooks');
}

function regexEscape(literal: string): string {
  return literal.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function globToRegex(glob: string): string {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 2;
        if (glob[i] === '/') i += 1;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '/') {
      out += '/';
      i += 1;
      continue;
    }
    out += regexEscape(ch);
    i += 1;
  }
  return out;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildCliArgs(opts: HookInstallOptions): string {
  const parts: string[] = [];
  if (opts.url) parts.push(shellQuote(opts.url));
  if (opts.configPath) parts.push('--config', shellQuote(opts.configPath));
  if (opts.checks && opts.checks.length > 0) {
    parts.push('--checks', shellQuote(opts.checks.join(',')));
  }
  if (opts.hookType === 'pre-push' && opts.full !== false) {
    parts.push('--all');
  }
  if (opts.since) {
    parts.push('--since', shellQuote(opts.since));
  }
  if (opts.extraArgs && opts.extraArgs.length > 0) {
    for (const a of opts.extraArgs) parts.push(shellQuote(a));
  }
  return parts.join(' ');
}

export async function generateHookScript(opts: HookInstallOptions = {}): Promise<string> {
  const hookType: HookType = opts.hookType ?? 'pre-commit';
  const timeoutMs = opts.timeoutMs ?? (hookType === 'pre-push' ? 300_000 : 60_000);
  const timeoutS = Math.max(1, Math.floor(timeoutMs / 1000));
  const patterns = opts.onlyIfPathsMatch ?? [];
  const patternsJoined = patterns.join('|');
  const regex = patterns.length > 0 ? patterns.map(globToRegex).join('|') : '';
  const cliArgs = buildCliArgs({ ...opts, hookType });
  const blocking = opts.blocking !== false;
  const blockingExit = blocking ? 'exit $EXIT' : 'echo "warning only"';
  const marker = markerFor(hookType);

  const lines: string[] = [];
  // Prefer POSIX sh for portability; all constructs below are sh-compatible.
  lines.push('#!/bin/sh');
  lines.push(marker);
  lines.push('set -e');

  if (hookType === 'pre-commit') {
    lines.push('# only run if staged files match patterns');
    lines.push(`if [ -n "${patternsJoined}" ]; then`);
    lines.push(`  matched=$(git diff --cached --name-only | grep -E ${shellQuote(regex)} || true)`);
    lines.push('  [ -z "$matched" ] && exit 0');
    lines.push('fi');
  } else {
    // pre-push reads <local-ref> <local-sha> <remote-ref> <remote-sha> on stdin.
    // We ignore stdin here; full audits inspect the built URL (config-supplied)
    // rather than a diff, so stdin parsing is not required.
    lines.push('# pre-push: run full uxinspect audit before remote push');
    lines.push(`if [ -n "${patternsJoined}" ]; then`);
    lines.push(`  matched=$(git diff --name-only @{push}..HEAD 2>/dev/null | grep -E ${shellQuote(regex)} || true)`);
    lines.push('  [ -z "$matched" ] && exit 0');
    lines.push('fi');
  }

  // `timeout` is GNU. Fall back to running without it if `timeout` is absent,
  // so the hook still works on macOS where `timeout` is not installed by default.
  lines.push('EXIT=0');
  lines.push('if command -v timeout >/dev/null 2>&1; then');
  lines.push(`  timeout ${timeoutS} npx uxinspect run ${cliArgs} || EXIT=$?`);
  lines.push('else');
  lines.push(`  npx uxinspect run ${cliArgs} || EXIT=$?`);
  lines.push('fi');
  lines.push('if [ "$EXIT" != "0" ]; then');
  lines.push(`  echo "uxinspect ${hookType} check failed (exit $EXIT)"`);
  lines.push(`  ${blockingExit}`);
  lines.push('fi');
  lines.push('exit 0');
  lines.push('');
  return lines.join('\n');
}

async function readHookIfExists(hookPath: string): Promise<string | undefined> {
  try {
    return await readFile(hookPath, 'utf8');
  } catch {
    return undefined;
  }
}

function isManaged(contents: string, hookType: HookType): boolean {
  // Accept either the typed marker or the legacy pre-commit marker (older installs).
  if (contents.includes(markerFor(hookType))) return true;
  if (hookType === 'pre-commit') {
    return contents.includes('# uxinspect-managed pre-commit hook (do not edit this marker line)');
  }
  return false;
}

function timestampTag(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

export async function installHook(
  opts: HookInstallOptions = {},
): Promise<HookInstallResult> {
  const hookType: HookType = opts.hookType ?? 'pre-commit';
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const gitDir = await findGitDir(repoRoot);
  if (!gitDir) {
    return {
      installed: false,
      hookPath: '',
      hookType,
      alreadyManaged: false,
      error: 'no .git directory found walking up from repoRoot',
    };
  }
  const hooksDir = await resolveHooksDir(repoRoot, gitDir);
  const hookPath = join(hooksDir, hookType);

  try {
    await mkdir(hooksDir, { recursive: true });
    const existing = await readHookIfExists(hookPath);
    let backupPath: string | undefined;
    let alreadyManaged = false;

    if (existing !== undefined) {
      if (isManaged(existing, hookType)) {
        alreadyManaged = true;
      } else if (!opts.force) {
        return {
          installed: false,
          hookPath,
          hookType,
          alreadyManaged: false,
          error: 'existing hook present; use force',
        };
      } else {
        backupPath = join(hooksDir, `${backupPrefixFor(hookType)}${timestampTag()}`);
        await rename(hookPath, backupPath);
      }
    }

    const script = await generateHookScript({ ...opts, hookType });
    await writeFile(hookPath, script, 'utf8');
    await chmod(hookPath, 0o755);

    return {
      installed: true,
      hookPath,
      hookType,
      backupPath,
      alreadyManaged,
    };
  } catch (err) {
    return {
      installed: false,
      hookPath,
      hookType,
      alreadyManaged: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function uninstallHook(
  hookType: HookType = 'pre-commit',
  repoRoot?: string,
): Promise<{ removed: boolean; hookType: HookType; error?: string }> {
  const root = resolve(repoRoot ?? process.cwd());
  const gitDir = await findGitDir(root);
  if (!gitDir) {
    return { removed: false, hookType, error: 'no .git directory found walking up from repoRoot' };
  }
  try {
    const hooksDir = await resolveHooksDir(root, gitDir);
    const hookPath = join(hooksDir, hookType);
    const existing = await readHookIfExists(hookPath);
    let removed = false;

    if (existing !== undefined && isManaged(existing, hookType)) {
      await unlink(hookPath);
      removed = true;
    }

    const backupPrefix = backupPrefixFor(hookType);
    const entries = await readdir(hooksDir).catch(() => [] as string[]);
    const backups = entries
      .filter((e) => e.startsWith(backupPrefix))
      .sort()
      .reverse();
    if (backups.length > 0) {
      const latest = join(hooksDir, backups[0]);
      if (!(await pathExists(hookPath))) {
        await rename(latest, hookPath);
        removed = true;
      }
    }
    return { removed, hookType };
  } catch (err) {
    return { removed: false, hookType, error: err instanceof Error ? err.message : String(err) };
  }
}

// Backwards-compatible wrappers for the original pre-commit-only API.
export function installPrecommit(
  opts: PrecommitInstallOptions = {},
): Promise<PrecommitInstallResult> {
  return installHook({ ...opts, hookType: 'pre-commit' });
}

export async function uninstallPrecommit(
  repoRoot?: string,
): Promise<{ removed: boolean; error?: string }> {
  const r = await uninstallHook('pre-commit', repoRoot);
  return { removed: r.removed, error: r.error };
}
