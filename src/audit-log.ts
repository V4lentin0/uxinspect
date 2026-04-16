/**
 * P8 #75 — Audit log with tamper-evident hash chain.
 * Append-only log. Each entry hashes the previous entry for integrity.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface AuditEntry {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  resource: string;
  resourceId?: string;
  detail?: string;
  prevHash: string;
  hash: string;
}

let lastHash = '0000000000000000000000000000000000000000000000000000000000000000';

export async function appendAuditLog(
  logDir: string,
  actor: string,
  action: string,
  resource: string,
  resourceId?: string,
  detail?: string,
): Promise<AuditEntry> {
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const payload = `${id}:${timestamp}:${actor}:${action}:${resource}:${resourceId || ''}:${detail || ''}:${lastHash}`;
  const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  const hash = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');

  const entry: AuditEntry = { id, timestamp, actor, action, resource, resourceId, detail, prevHash: lastHash, hash };
  lastHash = hash;

  const logFile = path.join(logDir, 'audit.ndjson');
  await fs.mkdir(logDir, { recursive: true });
  await fs.appendFile(logFile, JSON.stringify(entry) + '\n');

  return entry;
}

export async function verifyAuditChain(logDir: string): Promise<{ valid: boolean; entries: number; brokenAt?: number }> {
  const logFile = path.join(logDir, 'audit.ndjson');
  let content: string;
  try {
    content = await fs.readFile(logFile, 'utf-8');
  } catch {
    return { valid: true, entries: 0 };
  }

  const lines = content.trim().split('\n').filter(Boolean);
  let prevHash = '0000000000000000000000000000000000000000000000000000000000000000';

  for (let i = 0; i < lines.length; i++) {
    const entry = JSON.parse(lines[i]) as AuditEntry;
    if (entry.prevHash !== prevHash) return { valid: false, entries: lines.length, brokenAt: i };
    const payload = `${entry.id}:${entry.timestamp}:${entry.actor}:${entry.action}:${entry.resource}:${entry.resourceId || ''}:${entry.detail || ''}:${entry.prevHash}`;
    const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    const computed = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    if (computed !== entry.hash) return { valid: false, entries: lines.length, brokenAt: i };
    prevHash = entry.hash;
  }

  return { valid: true, entries: lines.length };
}
