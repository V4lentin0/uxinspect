import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { InspectResult } from './types.js';
import { checkBudget, type Budget, type BudgetViolation } from './budget.js';

export interface BudgetFile {
  $schema?: string;
  version: 1;
  budgets: Budget;
  description?: string;
  tags?: string[];
}

const ALLOWED_TOP_KEYS: ReadonlySet<string> = new Set([
  '$schema',
  'version',
  'budgets',
  'description',
  'tags',
]);

const KNOWN_BUDGET_GROUPS: ReadonlySet<string> = new Set([
  'perf',
  'metrics',
  'a11y',
  'visual',
  'flows',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function pathLabel(parts: readonly string[]): string {
  return parts.length === 0 ? '<root>' : parts.join('.');
}

function validateLeaf(value: unknown, parts: readonly string[]): void {
  if (!isFiniteNumber(value)) {
    throw new Error(`${pathLabel(parts)} must be number`);
  }
}

function validateBudgetNode(value: unknown, parts: readonly string[], depth: number): void {
  if (isFiniteNumber(value)) return;
  if (!isRecord(value)) {
    throw new Error(
      `${pathLabel(parts)} must be number or nested object with numeric leaves`,
    );
  }
  if (depth >= 2) {
    // Only two levels of nesting are allowed: budgets.<group>.<metric>
    throw new Error(
      `${pathLabel(parts)} exceeds max nesting depth; use number at this level`,
    );
  }
  for (const [key, child] of Object.entries(value)) {
    const next = [...parts, key];
    if (depth === 1) {
      validateLeaf(child, next);
    } else {
      validateBudgetNode(child, next, depth + 1);
    }
  }
}

function validateBudgets(raw: unknown): Budget {
  if (!isRecord(raw)) {
    throw new Error(`budgets must be object`);
  }
  for (const [group, node] of Object.entries(raw)) {
    // Allow forward-compat groups but still require numeric leaves everywhere.
    // Known groups get the standard two-level validation.
    const parts = ['budgets', group];
    if (KNOWN_BUDGET_GROUPS.has(group)) {
      validateBudgetNode(node, parts, 1);
    } else {
      validateBudgetNode(node, parts, 1);
    }
  }
  return raw as unknown as Budget;
}

function validateTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`tags must be string[]`);
  }
  raw.forEach((item, index) => {
    if (typeof item !== 'string') {
      throw new Error(`tags[${index}] must be string`);
    }
  });
  return raw as string[];
}

export function validateBudgetFile(data: unknown): BudgetFile {
  if (!isRecord(data)) {
    throw new Error(`budget file must be a JSON object`);
  }
  for (const key of Object.keys(data)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      throw new Error(`unknown top-level key '${key}'`);
    }
  }
  if (data.version !== 1) {
    throw new Error(`version must be 1`);
  }
  if (!('budgets' in data)) {
    throw new Error(`budgets is required`);
  }
  const budgets = validateBudgets(data.budgets);
  const out: BudgetFile = { version: 1, budgets };
  if ('$schema' in data && data.$schema !== undefined) {
    if (typeof data.$schema !== 'string') {
      throw new Error(`$schema must be string`);
    }
    out.$schema = data.$schema;
  }
  if ('description' in data && data.description !== undefined) {
    if (typeof data.description !== 'string') {
      throw new Error(`description must be string`);
    }
    out.description = data.description;
  }
  if ('tags' in data && data.tags !== undefined) {
    out.tags = validateTags(data.tags);
  }
  return out;
}

export async function loadBudgetFile(filePath: string): Promise<BudgetFile> {
  if (!filePath.toLowerCase().endsWith('.json')) {
    throw new Error(`budget file must be .json: ${filePath}`);
  }
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to read budget file ${filePath}: ${msg}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to parse JSON at ${filePath}: ${msg}`);
  }
  try {
    return validateBudgetFile(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid budget file ${filePath}: ${msg}`);
  }
}

export function mergeBudgets(base: Budget, override: Partial<Budget>): Budget {
  const merged: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    merged[key] = value;
  }
  return merged as unknown as Budget;
}

export function applyBudget(result: InspectResult, budget: Budget): BudgetViolation[] {
  return checkBudget(result, budget);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function discoverBudgetFile(startDir: string): Promise<string | null> {
  const resolved = path.resolve(startDir);
  let current = resolved;
  // Guard against infinite loops on malformed inputs
  const maxHops = 64;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const candidate = path.join(current, 'uxinspect.budget.json');
    if (await pathExists(candidate)) {
      return candidate;
    }
    const gitMarker = path.join(current, '.git');
    if (await pathExists(gitMarker)) {
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  return null;
}
