import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { StoredFlowResult, StoredInspectResult, StoredStepResult } from './types';
import type { FlowJumper } from './flowJumper';

/**
 * Reads `.uxinspect/last.json` (+ any failure-marker files the runner drops
 * into `.uxinspect/`) and emits a `vscode.Diagnostic` per failed flow step.
 *
 * Each diagnostic targets the flow file resolved by FlowJumper (falls back to
 * the uxinspect config file when the flow isn't a standalone file). The line
 * number is best-effort: we use the step index, clamped to the document
 * length once the diagnostic is rendered.
 *
 * The watcher is disposed when the extension deactivates.
 */
export class DiagnosticsProvider {
  private readonly collection: vscode.DiagnosticCollection;
  private watcher: vscode.FileSystemWatcher | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly jumper: FlowJumper,
  ) {
    this.collection = vscode.languages.createDiagnosticCollection('uxinspect');
    this.disposables.push(this.collection);
  }

  /** Start watching the configured result file, plus `.uxinspect/*.failure`. */
  start(): void {
    const cfg = vscode.workspace.getConfiguration('uxinspect');
    const resultRel = cfg.get<string>('lastResultFile', '.uxinspect/last.json');
    const showDiagnostics = cfg.get<boolean>('showDiagnostics', true);

    // If the user turned diagnostics off, leave the collection empty and skip
    // the watcher entirely — the refresh() path will respect the setting too.
    if (!showDiagnostics) {
      this.collection.clear();
      return;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;
    const root = folders[0];

    // Watch the result file AND any `.uxinspect/*.failure` sentinel files the
    // runner may drop as fast-path markers. Both trigger a full refresh.
    const pattern = new vscode.RelativePattern(
      root,
      `{${resultRel},.uxinspect/*.failure,.uxinspect/failures.json}`,
    );
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const handler = (): void => {
      void this.refresh();
    };
    this.watcher.onDidChange(handler, null, this.disposables);
    this.watcher.onDidCreate(handler, null, this.disposables);
    this.watcher.onDidDelete(handler, null, this.disposables);
    this.disposables.push(this.watcher);

    // Re-run refresh() whenever the user flips the showDiagnostics flag or
    // changes flowsDir/lastResultFile so diagnostics stay in sync.
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('uxinspect.showDiagnostics') ||
          e.affectsConfiguration('uxinspect.flowsDir') ||
          e.affectsConfiguration('uxinspect.lastResultFile')
        ) {
          this.collection.clear();
          this.stopWatcher();
          this.start();
        }
      }),
    );

    // Initial pass so the editor has diagnostics on activation.
    void this.refresh();
  }

  /** Read the latest result and rebuild diagnostics for every failing flow. */
  async refresh(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('uxinspect');
    if (!cfg.get<boolean>('showDiagnostics', true)) {
      this.collection.clear();
      return;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;
    const root = folders[0].uri.fsPath;

    const resultRel = cfg.get<string>('lastResultFile', '.uxinspect/last.json');
    const resultPath = path.isAbsolute(resultRel)
      ? resultRel
      : path.join(root, resultRel);

    const result = await this.readJson(resultPath);
    this.collection.clear();
    if (!result || !Array.isArray(result.flows)) return;

    // Group diagnostics by resolved file URI so we can issue one set() per file.
    const perFile = new Map<string, vscode.Diagnostic[]>();
    for (const flow of result.flows) {
      if (flow.passed) continue;
      const diagnostics = await this.buildDiagnosticsForFlow(flow);
      for (const entry of diagnostics) {
        const key = entry.uri.toString();
        const list = perFile.get(key) ?? [];
        list.push(entry.diagnostic);
        perFile.set(key, list);
      }
    }

    for (const [uriStr, diags] of perFile) {
      this.collection.set(vscode.Uri.parse(uriStr), diags);
    }

    if (perFile.size > 0) {
      this.output.appendLine(
        `[uxinspect] Emitted ${totalCount(perFile)} diagnostic(s) across ${perFile.size} file(s).`,
      );
    }
  }

  dispose(): void {
    this.stopWatcher();
    for (const d of this.disposables) d.dispose();
  }

  /* ------------------------------ helpers ------------------------------- */

  private stopWatcher(): void {
    if (this.watcher) {
      this.watcher.dispose();
      this.watcher = null;
    }
  }

  private async readJson(p: string): Promise<StoredInspectResult | null> {
    try {
      if (!fs.existsSync(p)) return null;
      const raw = await fs.promises.readFile(p, 'utf8');
      return JSON.parse(raw) as StoredInspectResult;
    } catch (err) {
      this.output.appendLine(
        `[uxinspect] Failed to read ${p}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Convert a failed flow into one diagnostic per failed step. Each diagnostic
   * points at the flow file line index matching the step's position; this is a
   * best-effort mapping — the runner currently doesn't emit precise source
   * locations, but step-index-aligned line numbers still help users navigate
   * long flows.
   */
  private async buildDiagnosticsForFlow(
    flow: StoredFlowResult,
  ): Promise<{ uri: vscode.Uri; diagnostic: vscode.Diagnostic }[]> {
    const location = await this.jumper.locate(flow.name);
    if (!location) return [];

    const out: { uri: vscode.Uri; diagnostic: vscode.Diagnostic }[] = [];

    // Top-level flow error (e.g. setup failure) — pin it to the located line.
    if (flow.error && !flow.steps?.some((s) => !s.passed)) {
      out.push({
        uri: location.uri,
        diagnostic: this.makeDiagnostic(
          location.line,
          `Flow '${flow.name}' failed: ${flow.error}`,
          vscode.DiagnosticSeverity.Error,
        ),
      });
      return out;
    }

    const steps = flow.steps ?? [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.passed) continue;
      const message = this.formatStepMessage(flow.name, i, step);
      out.push({
        uri: location.uri,
        diagnostic: this.makeDiagnostic(
          location.line + i,
          message,
          vscode.DiagnosticSeverity.Error,
        ),
      });
    }
    return out;
  }

  private formatStepMessage(
    flowName: string,
    stepIndex: number,
    step: StoredStepResult,
  ): string {
    const action = describeStep(step.step);
    const base = `uxinspect: flow '${flowName}' step ${stepIndex + 1} (${action}) failed`;
    if (step.error) return `${base}: ${step.error}`;
    const firstAssertion = step.assertions?.[0];
    if (firstAssertion) return `${base}: ${firstAssertion.kind} — ${firstAssertion.message}`;
    return `${base}.`;
  }

  private makeDiagnostic(
    line: number,
    message: string,
    severity: vscode.DiagnosticSeverity,
  ): vscode.Diagnostic {
    const safeLine = Math.max(0, line);
    const range = new vscode.Range(safeLine, 0, safeLine, Number.MAX_SAFE_INTEGER);
    const diag = new vscode.Diagnostic(range, message, severity);
    diag.source = 'uxinspect';
    return diag;
  }
}

function describeStep(step: unknown): string {
  if (!step || typeof step !== 'object') return 'step';
  const keys = Object.keys(step as Record<string, unknown>);
  // A StepAction has a single load-bearing key ('click', 'goto', etc.). The
  // optional 'assert' and 'captureOptions' keys are ignored for the label.
  const primary = keys.find((k) => k !== 'assert' && k !== 'captureOptions') ?? keys[0];
  if (!primary) return 'step';
  const value = (step as Record<string, unknown>)[primary];
  if (typeof value === 'string') return `${primary}: ${value}`;
  return primary;
}

function totalCount(map: Map<string, vscode.Diagnostic[]>): number {
  let n = 0;
  for (const list of map.values()) n += list.length;
  return n;
}
