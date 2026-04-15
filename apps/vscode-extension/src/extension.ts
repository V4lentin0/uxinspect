import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { findFlowLocations, FlowLocation } from './flow-locator';

// ---------------------------------------------------------------------------
// last.json shape (mirrors src/types.ts subset we care about)
// ---------------------------------------------------------------------------
interface Step {
  click?: string;
  goto?: string;
  type?: { selector: string; text: string };
  fill?: { selector: string; text: string };
  waitFor?: string;
  hover?: string;
  [key: string]: unknown;
}

interface StepResult {
  step: Step;
  passed: boolean;
  durationMs: number;
  error?: string;
}

interface FlowResult {
  name: string;
  passed: boolean;
  steps: StepResult[];
  screenshots?: string[];
  error?: string;
}

interface LastRun {
  url?: string;
  startedAt?: string;
  finishedAt?: string;
  flows?: FlowResult[];
  passed?: boolean;
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
let diagnosticCollection: vscode.DiagnosticCollection;
let statusBarItem: vscode.StatusBarItem;
let watcher: vscode.FileSystemWatcher | undefined;

export function activate(context: vscode.ExtensionContext): void {
  diagnosticCollection = vscode.languages.createDiagnosticCollection('uxinspect');
  context.subscriptions.push(diagnosticCollection);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'uxinspect.openReport';
  statusBarItem.text = '$(beaker) uxinspect: no run yet';
  statusBarItem.tooltip = 'Click to open the uxinspect HTML report';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('uxinspect.runFast', runFast),
    vscode.commands.registerCommand('uxinspect.openReport', openReport),
    vscode.commands.registerCommand('uxinspect.replayFailure', replayFailure),
    vscode.commands.registerCommand('uxinspect.refreshDiagnostics', () => refreshAll(context))
  );

  // Watch the last.json file in every workspace folder.
  const lastRunRel = getConfig<string>('lastRunPath', '.uxinspect/last.json');
  const pattern = '**/' + lastRunRel.replace(/^\.\//, '');
  watcher = vscode.workspace.createFileSystemWatcher(pattern);
  watcher.onDidChange(() => refreshAll(context));
  watcher.onDidCreate(() => refreshAll(context));
  watcher.onDidDelete(() => refreshAll(context));
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('uxinspect')) {
        refreshAll(context);
      }
    })
  );

  // First paint.
  refreshAll(context).catch((err: unknown) => {
    console.error('[uxinspect] initial refresh failed', err);
  });
}

export function deactivate(): void {
  if (diagnosticCollection) {
    diagnosticCollection.dispose();
  }
  if (statusBarItem) {
    statusBarItem.dispose();
  }
  if (watcher) {
    watcher.dispose();
  }
}

// ---------------------------------------------------------------------------
// Refresh pipeline
// ---------------------------------------------------------------------------
async function refreshAll(_context: vscode.ExtensionContext): Promise<void> {
  diagnosticCollection.clear();
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    statusBarItem.text = '$(beaker) uxinspect: no workspace';
    return;
  }

  let totalFlows = 0;
  let totalFailed = 0;
  let anyData = false;

  for (const folder of folders) {
    const run = await readLastRun(folder);
    if (!run || !run.flows) continue;
    anyData = true;
    totalFlows += run.flows.length;
    totalFailed += run.flows.filter((f) => !f.passed).length;

    await publishDiagnosticsForFolder(folder, run);
  }

  if (!anyData) {
    statusBarItem.text = '$(beaker) uxinspect: no run yet';
    statusBarItem.tooltip = 'Run `uxinspect run` to populate diagnostics';
    statusBarItem.backgroundColor = undefined;
    return;
  }

  const passed = totalFlows - totalFailed;
  if (totalFailed === 0) {
    statusBarItem.text = `$(pass) uxinspect: ${passed}/${totalFlows} passed`;
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = `$(error) uxinspect: ${totalFailed} failed / ${totalFlows} total`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }
  statusBarItem.tooltip = 'Click to open the uxinspect HTML report';
}

async function readLastRun(folder: vscode.WorkspaceFolder): Promise<LastRun | undefined> {
  const rel = getConfig<string>('lastRunPath', '.uxinspect/last.json');
  const abs = path.join(folder.uri.fsPath, rel);
  try {
    const raw = await fs.promises.readFile(abs, 'utf8');
    return JSON.parse(raw) as LastRun;
  } catch {
    return undefined;
  }
}

async function publishDiagnosticsForFolder(folder: vscode.WorkspaceFolder, run: LastRun): Promise<void> {
  const failed = (run.flows ?? []).filter((f) => !f.passed);
  if (failed.length === 0) return;

  const glob = getConfig<string>('flowsGlob', '**/*.{ts,tsx,js,jsx,mjs,cjs}');
  const relPattern = new vscode.RelativePattern(folder, glob);
  const files = await vscode.workspace.findFiles(relPattern, '**/node_modules/**', 500);

  const byFile = new Map<string, vscode.Diagnostic[]>();

  for (const fileUri of files) {
    let text: string;
    try {
      text = await fs.promises.readFile(fileUri.fsPath, 'utf8');
    } catch {
      continue;
    }
    const locs = findFlowLocations(text);
    if (locs.length === 0) continue;
    const locByName = new Map<string, FlowLocation>();
    for (const loc of locs) locByName.set(loc.name, loc);

    for (const flow of failed) {
      const loc = locByName.get(flow.name);
      if (!loc) continue;
      const diag = buildDiagnostic(flow, loc);
      const list = byFile.get(fileUri.fsPath) ?? [];
      list.push(diag);
      byFile.set(fileUri.fsPath, list);
    }
  }

  for (const [file, diags] of byFile) {
    diagnosticCollection.set(vscode.Uri.file(file), diags);
  }
}

function buildDiagnostic(flow: FlowResult, loc: FlowLocation): vscode.Diagnostic {
  const range = new vscode.Range(
    new vscode.Position(loc.line, loc.column),
    new vscode.Position(loc.line, loc.column + loc.nameLength)
  );
  const firstBroken = (flow.steps || []).find((s) => !s.passed);
  const summary = describeStep(firstBroken);
  const msg = firstBroken
    ? `uxinspect: flow "${flow.name}" failed — ${summary}${firstBroken.error ? ` (${firstBroken.error})` : ''}`
    : `uxinspect: flow "${flow.name}" failed${flow.error ? ` — ${flow.error}` : ''}`;
  const diag = new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Error);
  diag.source = 'uxinspect';
  diag.code = 'broken-flow';
  return diag;
}

function describeStep(step: StepResult | undefined): string {
  if (!step) return 'unknown step';
  const s = step.step || {};
  if (typeof s.click === 'string') return `broken click on "${s.click}"`;
  if (typeof s.goto === 'string') return `failed to goto ${s.goto}`;
  if (s.type && typeof s.type === 'object') return `failed to type into "${s.type.selector}"`;
  if (s.fill && typeof s.fill === 'object') return `failed to fill "${s.fill.selector}"`;
  if (typeof s.waitFor === 'string') return `waitFor "${s.waitFor}" timed out`;
  if (typeof s.hover === 'string') return `hover on "${s.hover}" failed`;
  const key = Object.keys(s)[0];
  return key ? `step "${key}" failed` : 'step failed';
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

function getConfig<T>(key: string, fallback: T): T {
  const cfg = vscode.workspace.getConfiguration('uxinspect');
  const val = cfg.get<T>(key);
  return val === undefined ? fallback : val;
}

function getTerminal(): vscode.Terminal {
  const existing = vscode.window.terminals.find((t) => t.name === 'uxinspect');
  if (existing) return existing;
  return vscode.window.createTerminal({ name: 'uxinspect' });
}

function runFast(): void {
  const folder = getWorkspaceFolder();
  if (!folder) {
    vscode.window.showErrorMessage('uxinspect: open a workspace first');
    return;
  }
  const cli = getConfig<string>('cliCommand', 'npx uxinspect');
  const term = getTerminal();
  term.show(true);
  term.sendText(`${cli} run --fast`);
}

async function openReport(): Promise<void> {
  const folder = getWorkspaceFolder();
  if (!folder) {
    vscode.window.showErrorMessage('uxinspect: open a workspace first');
    return;
  }
  const rel = getConfig<string>('reportPath', 'report/index.html');
  const abs = path.join(folder.uri.fsPath, rel);
  if (!fs.existsSync(abs)) {
    vscode.window.showWarningMessage(`uxinspect: report not found at ${rel}. Run uxinspect first.`);
    return;
  }
  const uri = vscode.Uri.file(abs);
  await vscode.env.openExternal(uri);
}

async function replayFailure(): Promise<void> {
  const folder = getWorkspaceFolder();
  if (!folder) {
    vscode.window.showErrorMessage('uxinspect: open a workspace first');
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('uxinspect: place cursor on a flow to replay');
    return;
  }
  const text = editor.document.getText();
  const locations = findFlowLocations(text);
  if (locations.length === 0) {
    vscode.window.showInformationMessage('uxinspect: no flows found in this file');
    return;
  }
  const pos = editor.selection.active;
  const flow = pickFlowAtPosition(locations, text, pos.line);
  if (!flow) {
    vscode.window.showInformationMessage('uxinspect: place cursor inside a flow definition');
    return;
  }
  const run = await readLastRun(folder);
  if (!run || !run.flows) {
    vscode.window.showWarningMessage('uxinspect: no last.json found — run uxinspect first');
    return;
  }
  const matched = run.flows.find((f) => f.name === flow.name);
  if (!matched) {
    vscode.window.showWarningMessage(`uxinspect: flow "${flow.name}" not in last run`);
    return;
  }
  if (matched.passed) {
    vscode.window.showInformationMessage(`uxinspect: flow "${flow.name}" passed — nothing to replay`);
    return;
  }
  const replayPath = findReplayPath(matched);
  if (!replayPath) {
    vscode.window.showWarningMessage(`uxinspect: no replay recording found for "${flow.name}"`);
    return;
  }
  const cli = getConfig<string>('cliCommand', 'npx uxinspect');
  const term = getTerminal();
  term.show(true);
  term.sendText(`${cli} replay ${JSON.stringify(replayPath)}`);
}

function pickFlowAtPosition(locations: FlowLocation[], source: string, cursorLine: number): FlowLocation | undefined {
  // Pick the nearest flow definition at or above the cursor.
  const sorted = [...locations].sort((a, b) => a.line - b.line);
  let candidate: FlowLocation | undefined;
  for (const loc of sorted) {
    if (loc.line <= cursorLine) {
      candidate = loc;
    } else {
      break;
    }
  }
  // Ensure cursor is within ~50 lines of the flow decl (avoid matching across files).
  if (candidate && cursorLine - candidate.line > 200) {
    return undefined;
  }
  void source;
  return candidate;
}

function findReplayPath(flow: FlowResult): string | undefined {
  // Newer versions may embed replayPath; fall back to screenshots[] last entry.
  const anyFlow = flow as unknown as { replayPath?: string; replay?: string };
  if (typeof anyFlow.replayPath === 'string') return anyFlow.replayPath;
  if (typeof anyFlow.replay === 'string') return anyFlow.replay;
  if (Array.isArray(flow.screenshots) && flow.screenshots.length > 0) {
    const ss = flow.screenshots[flow.screenshots.length - 1];
    // Infer sibling replay file for convenience.
    if (typeof ss === 'string') {
      return ss.replace(/\.png$/i, '.json').replace(/screenshots/, 'replays');
    }
  }
  return undefined;
}

// Exported for tests.
export const __test = {
  describeStep,
  pickFlowAtPosition,
  findReplayPath,
};
