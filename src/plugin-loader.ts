/**
 * P9 #78 — Custom rule packs plugin loader.
 *
 * Enterprise-only feature. Scans a configured directory (default
 * `.uxinspect/plugins/`) for `.js` / `.mjs` files and dynamically imports
 * them as audit plugins. Each plugin must export a default object shaped
 * like `PluginDescriptor` (name + audits + optional lifecycle hooks).
 *
 * Gating: `loadPlugins` accepts a `licensePlan` argument. If the current
 * plan is anything other than `'enterprise'`, the loader returns an empty
 * list and records a license_gated event in the diagnostics array.
 *
 * This module has zero runtime dependencies outside of Node core so the
 * CLI can call it without incurring Playwright/Lighthouse cost until
 * plugins are actually executed.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** An audit unit exported by a plugin. */
export interface PluginAudit {
  id: string;
  description?: string;
  /**
   * Audit function. Receives the Playwright Page (typed as `unknown` to
   * avoid a hard dependency on Playwright here) plus an options bag,
   * returns an array of issue records.
   */
  run: (
    page: unknown,
    opts?: Record<string, unknown>,
  ) => Promise<PluginIssue[]> | PluginIssue[];
}

/** An issue produced by a plugin audit. */
export interface PluginIssue {
  type: string;
  message: string;
  severity: 'info' | 'warn' | 'error' | 'critical';
  selector?: string;
  detail?: unknown;
}

/** Lifecycle hooks a plugin may register. */
export interface PluginHooks {
  /** Called once when the run starts. */
  onStart?: (ctx: { url: string }) => Promise<void> | void;
  /** Called once when the run finishes, regardless of pass/fail. */
  onFinish?: (ctx: { url: string; passed: boolean }) => Promise<void> | void;
  /** Called before each flow step. */
  beforeStep?: (ctx: { flowName: string; stepIndex: number }) => Promise<void> | void;
  /** Called after each flow step. */
  afterStep?: (ctx: { flowName: string; stepIndex: number; passed: boolean }) => Promise<void> | void;
}

/** Descriptor a plugin file's default export must match. */
export interface PluginDescriptor {
  name: string;
  version?: string;
  description?: string;
  audits?: PluginAudit[];
  hooks?: PluginHooks;
}

/** Loader result entry. */
export interface LoadedPlugin extends PluginDescriptor {
  /** Path to the source file that produced this plugin. */
  path: string;
}

/** Diagnostic record emitted by {@link loadPlugins}. */
export interface PluginDiagnostic {
  path: string;
  kind:
    | 'license_gated'
    | 'load_error'
    | 'invalid_shape'
    | 'duplicate_name'
    | 'loaded';
  message?: string;
}

export interface LoadPluginsOptions {
  /** Directory containing plugin files. Default: `.uxinspect/plugins`. */
  dir?: string;
  /** Current license plan. Plugins require `'enterprise'`. */
  licensePlan?: 'free' | 'pro' | 'team' | 'enterprise';
  /** Collector for per-file diagnostics. If omitted, errors go to stderr. */
  diagnostics?: PluginDiagnostic[];
  /** Only accept files matching this predicate (used by tests). */
  fileFilter?: (name: string) => boolean;
}

export const DEFAULT_PLUGIN_DIR = path.join('.uxinspect', 'plugins');

/**
 * Legacy single-function signature kept for backwards compatibility with
 * early Enterprise design drafts. New code should use {@link loadPluginsFull}.
 */
export interface PluginModule {
  name: string;
  run: (
    page: unknown,
    opts?: Record<string, unknown>,
  ) => Promise<Array<{ type: string; message: string; severity: string }>>;
}

/** Back-compat: old signature returns just `{name, run}` per file. */
export async function loadPlugins(pluginDir: string): Promise<PluginModule[]> {
  const result = await loadPluginsFull({ dir: pluginDir, licensePlan: 'enterprise' });
  const flat: PluginModule[] = [];
  for (const p of result.plugins) {
    for (const a of p.audits ?? []) {
      flat.push({
        name: `${p.name}:${a.id}`,
        run: async (page, opts) => {
          const res = await a.run(page, opts);
          return res.map((r) => ({ type: r.type, message: r.message, severity: r.severity }));
        },
      });
    }
  }
  return flat;
}

/** Full plugin loader. */
export async function loadPluginsFull(
  opts: LoadPluginsOptions = {},
): Promise<{ plugins: LoadedPlugin[]; diagnostics: PluginDiagnostic[] }> {
  const dir = opts.dir ?? DEFAULT_PLUGIN_DIR;
  const plan = opts.licensePlan ?? 'free';
  const diagnostics = opts.diagnostics ?? [];

  if (plan !== 'enterprise') {
    diagnostics.push({
      path: dir,
      kind: 'license_gated',
      message: 'Custom plugins require an Enterprise license.',
    });
    return { plugins: [], diagnostics };
  }

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { plugins: [], diagnostics };
  }

  const filter = opts.fileFilter ?? ((n) => n.endsWith('.js') || n.endsWith('.mjs'));
  const seenNames = new Set<string>();
  const plugins: LoadedPlugin[] = [];

  for (const entry of entries.sort()) {
    if (!filter(entry)) continue;
    const full = path.resolve(dir, entry);
    try {
      const mod = await import(pathToFileURL(full).href);
      const descriptor = extractDescriptor(mod);
      if (!descriptor) {
        diagnostics.push({
          path: full,
          kind: 'invalid_shape',
          message: 'Expected default export with { name, audits?, hooks? }',
        });
        continue;
      }
      if (seenNames.has(descriptor.name)) {
        diagnostics.push({
          path: full,
          kind: 'duplicate_name',
          message: `Plugin name "${descriptor.name}" already loaded.`,
        });
        continue;
      }
      seenNames.add(descriptor.name);
      plugins.push({ ...descriptor, path: full });
      diagnostics.push({ path: full, kind: 'loaded' });
    } catch (err) {
      diagnostics.push({
        path: full,
        kind: 'load_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { plugins, diagnostics };
}

function extractDescriptor(mod: unknown): PluginDescriptor | null {
  if (!mod || typeof mod !== 'object') return null;
  const maybeDefault = (mod as Record<string, unknown>).default;
  const source = (maybeDefault && typeof maybeDefault === 'object' ? maybeDefault : mod) as Record<string, unknown>;
  const name = source.name;
  if (typeof name !== 'string' || !name.trim()) return null;
  const audits = Array.isArray(source.audits) ? (source.audits as PluginAudit[]) : [];
  const hooks = source.hooks && typeof source.hooks === 'object'
    ? (source.hooks as PluginHooks)
    : undefined;
  // Validate each audit has a string id + function run.
  for (const a of audits) {
    if (!a || typeof a !== 'object') return null;
    if (typeof a.id !== 'string' || typeof a.run !== 'function') return null;
  }
  return {
    name,
    version: typeof source.version === 'string' ? source.version : undefined,
    description: typeof source.description === 'string' ? source.description : undefined,
    audits,
    hooks,
  };
}

/**
 * `uxinspect plugins list` implementation.
 * Returns a text summary the CLI prints to stdout.
 */
export async function listPlugins(opts: LoadPluginsOptions = {}): Promise<string> {
  const { plugins, diagnostics } = await loadPluginsFull(opts);
  if (diagnostics.some((d) => d.kind === 'license_gated')) {
    return 'Custom plugins require an Enterprise license.';
  }
  if (plugins.length === 0) {
    return `No plugins found in ${opts.dir ?? DEFAULT_PLUGIN_DIR}.`;
  }
  const lines = [`Loaded ${plugins.length} plugin(s) from ${opts.dir ?? DEFAULT_PLUGIN_DIR}:`];
  for (const p of plugins) {
    const auditCount = p.audits?.length ?? 0;
    const hookList = p.hooks
      ? Object.keys(p.hooks).filter((k) => typeof (p.hooks as Record<string, unknown>)[k] === 'function')
      : [];
    lines.push(
      `  - ${p.name}${p.version ? `@${p.version}` : ''} — ${auditCount} audit(s)` +
        (hookList.length ? `, hooks: ${hookList.join(', ')}` : ''),
    );
  }
  return lines.join('\n');
}

/**
 * `uxinspect plugins install <pkg>` — copies a JS plugin file into the
 * configured plugin directory. For npm installs the caller is expected
 * to run `npm install <pkg>` separately and then point `install` at the
 * package's entry file.
 */
export async function installPlugin(source: string, opts: LoadPluginsOptions = {}): Promise<string> {
  const dir = opts.dir ?? DEFAULT_PLUGIN_DIR;
  await fs.mkdir(dir, { recursive: true });
  const base = path.basename(source);
  const target = path.resolve(dir, base);
  await fs.copyFile(source, target);
  return target;
}

/** `uxinspect plugins remove <name>`. */
export async function removePlugin(name: string, opts: LoadPluginsOptions = {}): Promise<boolean> {
  const dir = opts.dir ?? DEFAULT_PLUGIN_DIR;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return false;
  }
  const match = entries.find(
    (e) => e === name || e === `${name}.js` || e === `${name}.mjs`,
  );
  if (!match) return false;
  await fs.unlink(path.resolve(dir, match));
  return true;
}
