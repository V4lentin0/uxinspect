import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { StoredFlowResult, StoredInspectResult } from './types';

/**
 * Locates where a flow is defined on disk and exposes commands for jumping to
 * it. Flow files are typically either:
 *   1. Standalone files in `flows/<name>.ts|js|json` (one flow per file), or
 *   2. Inline entries inside `uxinspect.config.ts` — detected via the string
 *      `name: '<flow-name>'` pattern.
 *
 * We try (1) first (fast path, no file content parsing), and fall back to (2)
 * with a single scan of the config file. If nothing matches we open the config
 * file at the top. Workspace-trust aware: returns `null` when trust is denied.
 */

export interface FlowLocation {
  uri: vscode.Uri;
  /** Zero-based line index, ready for `vscode.Position`. */
  line: number;
}

export class FlowJumper {
  constructor(private readonly output: vscode.OutputChannel) {}

  /** Load the latest result and return a display-ready list of flow names. */
  async listFlowNames(): Promise<string[]> {
    const result = await this.readLastResult();
    if (!result?.flows?.length) return [];
    return result.flows.map((f) => f.name);
  }

  /** Load the latest result and return full flow entries. */
  async listFlows(): Promise<StoredFlowResult[]> {
    const result = await this.readLastResult();
    return result?.flows ?? [];
  }

  /**
   * Resolve a flow name to a file location. Attempts, in order:
   *   1. flow.filePath/line if uxinspect already emitted them,
   *   2. `<flowsDir>/<name>.{ts,js,json}`,
   *   3. scan of the config file for a matching `name:` literal.
   */
  async locate(flowName: string): Promise<FlowLocation | null> {
    const workspace = this.workspaceRoot();
    if (!workspace) return null;

    const cfg = vscode.workspace.getConfiguration('uxinspect');
    const flowsDir = cfg.get<string>('flowsDir', 'flows/');
    const configFile = cfg.get<string>('configFile', 'uxinspect.config.ts');

    // 1. Trust an explicit pointer from the result.
    const flow = (await this.listFlows()).find((f) => f.name === flowName);
    if (flow?.filePath) {
      const abs = path.isAbsolute(flow.filePath)
        ? flow.filePath
        : path.join(workspace, flow.filePath);
      if (await fileExists(abs)) {
        return { uri: vscode.Uri.file(abs), line: Math.max(0, (flow.line ?? 1) - 1) };
      }
    }

    // 2. Look for flows/<name>.{ts,js,json}.
    const dir = path.isAbsolute(flowsDir) ? flowsDir : path.join(workspace, flowsDir);
    const candidates = ['.ts', '.js', '.json', '.mjs', '.cjs'].map((ext) =>
      path.join(dir, `${flowName}${ext}`),
    );
    for (const c of candidates) {
      if (await fileExists(c)) {
        return { uri: vscode.Uri.file(c), line: 0 };
      }
    }

    // 3. Fall back to scanning the config file for `name: 'flowName'`.
    const configAbs = path.isAbsolute(configFile)
      ? configFile
      : path.join(workspace, configFile);
    if (await fileExists(configAbs)) {
      const line = await this.findNameLineIn(configAbs, flowName);
      return { uri: vscode.Uri.file(configAbs), line: line ?? 0 };
    }

    this.output.appendLine(
      `[uxinspect] Could not locate flow '${flowName}' under '${flowsDir}' or config file '${configFile}'.`,
    );
    return null;
  }

  /**
   * Primary command handler: show a quick-pick of known flows and jump to the
   * selected one. Failed flows are surfaced with a short detail string.
   */
  async pickAndJump(): Promise<void> {
    const flows = await this.listFlows();
    if (!flows.length) {
      vscode.window.showInformationMessage(
        'uxinspect: no flows found. Run uxinspect first to populate .uxinspect/last.json.',
      );
      return;
    }
    const items: vscode.QuickPickItem[] = flows.map((f) => ({
      label: f.name,
      description: f.passed ? 'passed' : 'failed',
      detail: f.passed ? undefined : truncate(f.error ?? firstStepError(f) ?? 'Failed.', 160),
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a flow to open its definition',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;
    await this.openFlow(picked.label);
  }

  /** Open the flow definition for the given name. */
  async openFlow(flowName: string): Promise<void> {
    const location = await this.locate(flowName);
    if (!location) {
      vscode.window.showWarningMessage(
        `uxinspect: could not find a definition for flow '${flowName}'.`,
      );
      return;
    }
    const doc = await vscode.workspace.openTextDocument(location.uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const pos = new vscode.Position(location.line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(
      new vscode.Range(pos, pos),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
  }

  /* ----------------------------- helpers ------------------------------- */

  private workspaceRoot(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    return folders[0].uri.fsPath;
  }

  private lastResultPath(): string | null {
    const workspace = this.workspaceRoot();
    if (!workspace) return null;
    const cfg = vscode.workspace.getConfiguration('uxinspect');
    const rel = cfg.get<string>('lastResultFile', '.uxinspect/last.json');
    return path.isAbsolute(rel) ? rel : path.join(workspace, rel);
  }

  private async readLastResult(): Promise<StoredInspectResult | null> {
    const p = this.lastResultPath();
    if (!p || !(await fileExists(p))) return null;
    try {
      const raw = await fs.promises.readFile(p, 'utf8');
      return JSON.parse(raw) as StoredInspectResult;
    } catch (err) {
      this.output.appendLine(
        `[uxinspect] Failed to parse ${p}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async findNameLineIn(file: string, flowName: string): Promise<number | null> {
    try {
      const text = await fs.promises.readFile(file, 'utf8');
      const lines = text.split(/\r?\n/);
      const escaped = flowName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`name\\s*:\\s*['"\`]${escaped}['"\`]`);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) return i;
      }
    } catch {
      // fall through — caller uses 0 as the default line.
    }
    return null;
  }
}

function firstStepError(flow: StoredFlowResult): string | undefined {
  for (const s of flow.steps ?? []) {
    if (!s.passed && s.error) return s.error;
  }
  return undefined;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '\u2026';
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
