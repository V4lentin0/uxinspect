import path from 'node:path';

/**
 * Path-safety primitives for the MCP server.
 *
 * Every tool and resource handler MUST pipe any incoming path (from a model,
 * an IDE, a config file) through {@link resolveInsideCwd} before touching the
 * filesystem. This prevents directory traversal attacks — a compromised or
 * untrusted model cannot read `/etc/passwd` or write outside the project.
 *
 * We also enforce the `.uxinspect/` boundary for all writes: tools that
 * persist data (history DB, last-run snapshot, replay caches) must live
 * inside `<cwd>/.uxinspect/` so users have a single directory to gitignore.
 */

export const UXINSPECT_DIR = '.uxinspect';

export class PathSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSecurityError';
  }
}

/**
 * Resolves `p` against `cwd` and asserts the result stays inside `cwd`.
 * Rejects absolute paths that escape, `..` traversal, and symlinks that
 * resolve outside the sandbox (callers should resolve symlinks separately
 * when they matter; this function compares post-resolve prefixes).
 */
export function resolveInsideCwd(p: string, cwd: string = process.cwd()): string {
  if (typeof p !== 'string' || p.length === 0) {
    throw new PathSecurityError('path must be a non-empty string');
  }
  const absCwd = path.resolve(cwd);
  const abs = path.resolve(absCwd, p);
  const rel = path.relative(absCwd, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathSecurityError(`path escapes cwd: ${p}`);
  }
  return abs;
}

/**
 * Like {@link resolveInsideCwd} but further restricts to `<cwd>/.uxinspect/`.
 * Use for any write that should land in the uxinspect work directory.
 */
export function resolveInsideUxinspect(p: string, cwd: string = process.cwd()): string {
  const abs = resolveInsideCwd(p, cwd);
  const absUx = path.resolve(cwd, UXINSPECT_DIR);
  const rel = path.relative(absUx, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathSecurityError(`path must live under ${UXINSPECT_DIR}/: ${p}`);
  }
  return abs;
}
