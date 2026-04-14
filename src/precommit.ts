import { access, chmod, constants, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';

export interface PrecommitInstallOptions {
  repoRoot?: string;
  url?: string;
  configPath?: string;
  checks?: string[];
  blocking?: boolean;
  onlyIfPathsMatch?: string[];
  timeoutMs?: number;
  force?: boolean;
}

export interface PrecommitInstallResult {
  installed: boolean;
  hookPath: string;
  backupPath?: string;
  alreadyManaged: boolean;
  error?: string;
}

const MARKER = '# uxinspect-managed pre-commit hook (do not edit this marker line)';
const BACKUP_PREFIX = 'pre-commit.uxinspect-backup-';

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

function buildCliArgs(opts: PrecommitInstallOptions): string {
  const parts: string[] = [];
  if (opts.url) parts.push(shellQuote(opts.url));
  if (opts.configPath) parts.push('--config', shellQuote(opts.configPath));
  if (opts.checks && opts.checks.length > 0) {
    parts.push('--checks', shellQuote(opts.checks.join(',')));
  }
  return parts.join(' ');
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function generateHookScript(opts: PrecommitInstallOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const timeoutS = Math.max(1, Math.floor(timeoutMs / 1000));
  const patterns = opts.onlyIfPathsMatch ?? [];
  const patternsJoined = patterns.join('|');
  const regex = patterns.length > 0 ? patterns.map(globToRegex).join('|') : '';
  const cliArgs = buildCliArgs(opts);
  const blocking = opts.blocking !== false;
  const blockingExit = blocking ? 'exit $EXIT' : 'echo "warning only"';

  const lines: string[] = [];
  lines.push('#!/usr/bin/env bash');
  lines.push(MARKER);
  lines.push('set -e');
  lines.push('# only run if staged files match patterns');
  lines.push(`if [ -n "${patternsJoined}" ]; then`);
  lines.push(`  matched=$(git diff --cached --name-only | grep -E ${shellQuote(regex)} || true)`);
  lines.push('  [ -z "$matched" ] && exit 0');
  lines.push('fi');
  lines.push(`timeout ${timeoutS} npx uxinspect ${cliArgs} || EXIT=$?`);
  lines.push('if [ "${EXIT:-0}" != "0" ]; then');
  lines.push('  echo "uxinspect pre-commit check failed (exit $EXIT)"');
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

function isManaged(contents: string): boolean {
  return contents.includes(MARKER);
}

function timestampTag(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

export async function installPrecommit(
  opts: PrecommitInstallOptions = {},
): Promise<PrecommitInstallResult> {
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const gitDir = await findGitDir(repoRoot);
  if (!gitDir) {
    return {
      installed: false,
      hookPath: '',
      alreadyManaged: false,
      error: 'no .git directory found walking up from repoRoot',
    };
  }
  const hooksDir = await resolveHooksDir(repoRoot, gitDir);
  const hookPath = join(hooksDir, 'pre-commit');

  try {
    await mkdir(hooksDir, { recursive: true });
    const existing = await readHookIfExists(hookPath);
    let backupPath: string | undefined;
    let alreadyManaged = false;

    if (existing !== undefined) {
      if (isManaged(existing)) {
        alreadyManaged = true;
      } else if (!opts.force) {
        return {
          installed: false,
          hookPath,
          alreadyManaged: false,
          error: 'existing hook present; use force',
        };
      } else {
        backupPath = join(hooksDir, `${BACKUP_PREFIX}${timestampTag()}`);
        await rename(hookPath, backupPath);
      }
    }

    const script = await generateHookScript(opts);
    await writeFile(hookPath, script, 'utf8');
    await chmod(hookPath, 0o755);

    return {
      installed: true,
      hookPath,
      backupPath,
      alreadyManaged,
    };
  } catch (err) {
    return {
      installed: false,
      hookPath,
      alreadyManaged: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function uninstallPrecommit(
  repoRoot?: string,
): Promise<{ removed: boolean; error?: string }> {
  const root = resolve(repoRoot ?? process.cwd());
  const gitDir = await findGitDir(root);
  if (!gitDir) {
    return { removed: false, error: 'no .git directory found walking up from repoRoot' };
  }
  try {
    const hooksDir = await resolveHooksDir(root, gitDir);
    const hookPath = join(hooksDir, 'pre-commit');
    const existing = await readHookIfExists(hookPath);
    let removed = false;

    if (existing !== undefined && isManaged(existing)) {
      await unlink(hookPath);
      removed = true;
    }

    const entries = await readdir(hooksDir).catch(() => [] as string[]);
    const backups = entries
      .filter((e) => e.startsWith(BACKUP_PREFIX))
      .sort()
      .reverse();
    if (backups.length > 0) {
      const latest = join(hooksDir, backups[0]);
      if (!(await pathExists(hookPath))) {
        await rename(latest, hookPath);
        removed = true;
      }
    }
    return { removed };
  } catch (err) {
    return { removed: false, error: err instanceof Error ? err.message : String(err) };
  }
}
