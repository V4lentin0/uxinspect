// Produces two artefacts in dist/:
//   collector.min.js  — IIFE, minified, for <script> tag (auto-init if data-site-id)
//   collector.esm.js  — ESM, tree-shakeable, for npm consumers
// Also spits out a .d.ts via `tsc --emitDeclarationOnly` (run separately).
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const outDir = resolve(root, "dist");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const common = {
  entryPoints: [resolve(root, "src/collector.ts")],
  bundle: true,
  target: ["es2020"],
  platform: "browser",
  legalComments: "none",
  sourcemap: false,
  logLevel: "info",
};

await build({
  ...common,
  format: "iife",
  globalName: "uxi",
  minify: true,
  outfile: resolve(outDir, "collector.min.js"),
});

await build({
  ...common,
  format: "esm",
  minify: false,
  outfile: resolve(outDir, "collector.esm.js"),
});

// Write a minimal ambient d.ts so TS consumers get types without running tsc.
const dtsPath = resolve(outDir, "collector.d.ts");
writeFileSync(dtsPath, `export interface PrivacyConfig { mask?: string[]; disableRegex?: boolean }
export interface InitOptions {
  siteId: string;
  endpoint?: string;
  sampleRate?: number;
  privacy?: PrivacyConfig;
  debug?: boolean;
}
export declare function init(opts: InitOptions): void;
export declare function _stop(): void;
export type EventType = "pageview" | "click" | "vital" | "error" | "netfail";
export interface CollectorEvent { t: EventType; ts: number; url: string; sid: string; [k: string]: unknown }
`);

const min = readFileSync(resolve(outDir, "collector.min.js"));
const gz = gzipSync(min);
const BUDGET = 5 * 1024;
const info = {
  minified: min.length,
  gzipped: gz.length,
  budget: BUDGET,
  under: gz.length < BUDGET,
};
console.log(`[collector] minified=${info.minified}B gzipped=${info.gzipped}B budget=${BUDGET}B under=${info.under}`);
writeFileSync(resolve(outDir, "size.json"), JSON.stringify(info, null, 2));

if (!info.under) {
  console.error(`[collector] size budget exceeded: ${info.gzipped}B > ${BUDGET}B`);
  process.exit(1);
}
