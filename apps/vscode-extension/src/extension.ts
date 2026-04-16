import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DiagnosticsProvider } from './diagnosticsProvider';
import { FlowJumper } from './flowJumper';

/**
 * Entry point. Called by VS Code once when any of the activation events in
 * `package.json` fires. We set up:
 *   - a shared OUTPUT channel (also streams `uxinspect run` stdout/stderr)
 *   - FlowJumper (knows how to resolve flow names to files)
 *   - DiagnosticsProvider (watches .uxinspect/last.json and emits diagnostics)
 *   - three commands: uxinspect.runFlows, uxinspect.jumpToFlow,
 *     uxinspect.showLastReport.
 */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('uxinspect');
  context.subscriptions.push(output);
  output.appendLine('[uxinspect] Extension activated.');

  const jumper = new FlowJumper(output);
  const diagnostics = new DiagnosticsProvider(output, jumper);
  diagnostics.start();
  context.subscriptions.push({ dispose: () => diagnostics.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand('uxinspect.runFlows', () => runFlows(output)),
    vscode.commands.registerCommand('uxinspect.jumpToFlow', () => jumper.pickAndJump()),
    vscode.commands.registerCommand('uxinspect.showLastReport', () =>
      showLastReport(output),
    ),
  );
}

export function deactivate(): void {
  // All disposables are registered in `context.subscriptions`; VS Code will
  // dispose them automatically.
}

/**
 * Runs `uxinspect.runCommand` (default `npx uxinspect run`) through a VS Code
 * task terminal. We stream output to both the task terminal and the OUTPUT
 * panel so users see a consistent log. Uses a ShellExecution so we don't need
 * a separate Node subprocess, which keeps the activation cost low.
 */
async function runFlows(output: vscode.OutputChannel): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage('uxinspect: open a workspace folder first.');
    return;
  }
  const folder = folders[0];
  const cfg = vscode.workspace.getConfiguration('uxinspect');
  const command = cfg.get<string>('runCommand', 'npx uxinspect run');

  output.show(true);
  output.appendLine(`[uxinspect] $ ${command}`);

  const task = new vscode.Task(
    { type: 'shell', task: 'uxinspect-run' },
    folder,
    'uxinspect: run flows',
    'uxinspect',
    new vscode.ShellExecution(command, { cwd: folder.uri.fsPath }),
    [],
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
    echo: true,
    focus: false,
    showReuseMessage: false,
  };

  try {
    await vscode.tasks.executeTask(task);
  } catch (err) {
    const msg = (err as Error).message;
    output.appendLine(`[uxinspect] Failed to launch task: ${msg}`);
    vscode.window.showErrorMessage(`uxinspect: failed to start run — ${msg}`);
  }
}

/**
 * Opens the most recent report from `.uxinspect/last.json`. Prefers an HTML
 * report file (`uxinspect-report/index.html`) when present; falls back to the
 * JSON file itself in a text editor.
 */
async function showLastReport(output: vscode.OutputChannel): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage('uxinspect: open a workspace folder first.');
    return;
  }
  const root = folders[0].uri.fsPath;

  const cfg = vscode.workspace.getConfiguration('uxinspect');
  const resultRel = cfg.get<string>('lastResultFile', '.uxinspect/last.json');
  const resultPath = path.isAbsolute(resultRel) ? resultRel : path.join(root, resultRel);

  const htmlCandidates = [
    path.join(root, 'uxinspect-report', 'index.html'),
    path.join(root, 'report', 'index.html'),
  ];
  for (const html of htmlCandidates) {
    if (await exists(html)) {
      await vscode.env.openExternal(vscode.Uri.file(html));
      output.appendLine(`[uxinspect] Opened report ${html}`);
      return;
    }
  }

  if (!(await exists(resultPath))) {
    vscode.window.showInformationMessage(
      `uxinspect: no report yet. Run 'uxinspect: Run Flows' first (expected ${resultRel}).`,
    );
    return;
  }

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resultPath));
  await vscode.window.showTextDocument(doc, { preview: true });
  output.appendLine(`[uxinspect] Opened ${resultPath}`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
