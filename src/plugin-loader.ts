/**
 * P9 #78 — Custom rule packs plugin loader.
 * Enterprise-only. Loads user-defined audit modules from a configured directory.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface PluginModule {
  name: string;
  /** Audit function that receives a Page and returns issues. */
  run: (page: any, opts?: Record<string, unknown>) => Promise<Array<{ type: string; message: string; severity: string }>>;
}

export async function loadPlugins(pluginDir: string): Promise<PluginModule[]> {
  const plugins: PluginModule[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(pluginDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.endsWith('.js') && !entry.endsWith('.mjs')) continue;
    try {
      const mod = await import(path.resolve(pluginDir, entry));
      if (typeof mod.run === 'function' && typeof mod.name === 'string') {
        plugins.push({ name: mod.name, run: mod.run });
      }
    } catch (err) {
      console.error(`plugin_load_error: ${entry}`, err instanceof Error ? err.message : err);
    }
  }

  return plugins;
}
