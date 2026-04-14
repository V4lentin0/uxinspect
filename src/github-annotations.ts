import { appendFile, writeFile } from 'node:fs/promises';
import type { InspectResult } from './types.js';

type Level = 'error' | 'warning' | 'notice';

interface Issue {
  level: Level;
  message: string;
  source: string;
  target?: string;
}

interface FileLoc {
  file?: string;
  line?: number;
  col?: number;
}

export interface EmitOptions {
  fileMap?: (issue: { source: string; target?: string }) => FileLoc;
  out?: (line: string) => void;
}

function escapeData(value: string): string {
  return value
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

function escapeProp(value: string): string {
  return value
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C');
}

function formatCommand(level: Level, loc: FileLoc, message: string): string {
  const props: string[] = [];
  if (loc.file) props.push(`file=${escapeProp(loc.file)}`);
  if (typeof loc.line === 'number' && Number.isFinite(loc.line)) {
    props.push(`line=${loc.line}`);
  }
  if (typeof loc.col === 'number' && Number.isFinite(loc.col)) {
    props.push(`col=${loc.col}`);
  }
  const head = props.length ? `::${level} ${props.join(',')}` : `::${level}`;
  return `${head}::${escapeData(message)}`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function collectIssues(result: InspectResult): Issue[] {
  const issues: Issue[] = [];

  if (result.a11y) {
    for (const r of result.a11y) {
      for (const v of r.violations) {
        const level: Level =
          v.impact === 'critical' || v.impact === 'serious' ? 'error' : 'warning';
        for (const node of v.nodes) {
          const target = node.target?.[0];
          issues.push({
            level,
            message: oneLine(`a11y[${v.impact}] ${v.id}: ${v.help} (${r.page}) — ${v.helpUrl}`),
            source: r.page,
            target,
          });
        }
        if (v.nodes.length === 0) {
          issues.push({
            level,
            message: oneLine(`a11y[${v.impact}] ${v.id}: ${v.help} (${r.page})`),
            source: r.page,
          });
        }
      }
    }
  }

  if (result.retire) {
    for (const r of result.retire) {
      for (const f of r.findings) {
        for (const vuln of f.vulnerabilities) {
          const cves = vuln.identifiers?.CVE?.length
            ? ` [${vuln.identifiers.CVE.join(', ')}]`
            : '';
          issues.push({
            level: 'error',
            message: oneLine(
              `retire ${f.library}@${f.version} ${vuln.severity}: ${vuln.summary}${cves} (${f.url})`,
            ),
            source: f.url,
          });
        }
      }
    }
  }

  if (result.passiveSecurity) {
    for (const r of result.passiveSecurity) {
      for (const issue of r.issues) {
        const level: Level = issue.level === 'error' ? 'error' : 'warning';
        issues.push({
          level,
          message: oneLine(`passive-security ${issue.type}: ${issue.message} (${r.page})`),
          source: r.page,
          target: issue.selector,
        });
      }
    }
  }

  if (result.touchTargets) {
    for (const r of result.touchTargets) {
      for (const f of r.tooSmall) {
        issues.push({
          level: 'warning',
          message: oneLine(
            `touch-target too small ${Math.round(f.width)}x${Math.round(f.height)}: ${f.selector} (${r.page})`,
          ),
          source: r.page,
          target: f.selector,
        });
      }
      for (const f of r.overlapping) {
        issues.push({
          level: 'warning',
          message: oneLine(
            `touch-target overlaps ${f.overlapsWith ?? ''}: ${f.selector} (${r.page})`,
          ),
          source: r.page,
          target: f.selector,
        });
      }
    }
  }

  if (result.forms) {
    for (const r of result.forms) {
      for (const form of r.forms) {
        for (const issue of form.issues) {
          issues.push({
            level: 'warning',
            message: oneLine(
              `form ${issue.type}: ${issue.message} [${form.selector}] (${r.page})`,
            ),
            source: r.page,
            target: issue.selector,
          });
        }
      }
    }
  }

  if (result.keyboard) {
    for (const r of result.keyboard) {
      for (const issue of r.issues) {
        issues.push({
          level: 'warning',
          message: oneLine(`keyboard ${issue.type}: ${issue.message} (${r.page})`),
          source: r.page,
          target: issue.selector,
        });
      }
    }
  }

  if (result.exposedPaths) {
    for (const f of result.exposedPaths.findings) {
      issues.push({
        level: 'error',
        message: oneLine(
          `exposed-path[${f.severity}] ${f.path} → ${f.status} (${f.url})`,
        ),
        source: f.url,
      });
    }
  }

  if (result.consoleErrors) {
    for (const r of result.consoleErrors) {
      for (const issue of r.issues) {
        if (issue.type !== 'error' && issue.type !== 'pageerror' && issue.type !== 'unhandledrejection') {
          continue;
        }
        issues.push({
          level: 'warning',
          message: oneLine(
            `console[${issue.type}] ${issue.message}${issue.url ? ` @ ${issue.url}` : ''} (${r.page})`,
          ),
          source: issue.url ?? r.page,
        });
      }
    }
  }

  if (result.budget) {
    for (const b of result.budget) {
      issues.push({
        level: 'error',
        message: oneLine(`budget ${b.category}/${b.metric}: ${b.message}`),
        source: b.metric,
      });
    }
  }

  return issues;
}

export function emitGitHubAnnotations(
  result: InspectResult,
  opts?: EmitOptions,
): number {
  const write = opts?.out ?? ((line: string) => process.stdout.write(line + '\n'));
  const mapFn = opts?.fileMap;
  const issues = collectIssues(result);
  let count = 0;

  for (const issue of issues) {
    let loc: FileLoc = {};
    if (mapFn) {
      try {
        const mapped = mapFn({ source: issue.source, target: issue.target });
        if (mapped && typeof mapped === 'object') loc = mapped;
      } catch {
        loc = {};
      }
    }
    write(formatCommand(issue.level, loc, issue.message));
    count++;
  }

  return count;
}

function countSeverity(issues: Issue[]): { error: number; warning: number; notice: number } {
  const c = { error: 0, warning: 0, notice: 0 };
  for (const i of issues) c[i.level]++;
  return c;
}

function buildSummaryMarkdown(result: InspectResult): string {
  const issues = collectIssues(result);
  const counts = countSeverity(issues);
  const lines: string[] = [];

  lines.push('# uxinspect report');
  lines.push('');
  lines.push(`URL: ${result.url}`);
  lines.push(`Duration: ${result.durationMs} ms`);
  lines.push(`Status: ${result.passed ? 'PASSED' : 'FAILED'}`);
  lines.push('');
  lines.push('## Annotations');
  lines.push('');
  lines.push('| Level | Count |');
  lines.push('| --- | ---: |');
  lines.push(`| error | ${counts.error} |`);
  lines.push(`| warning | ${counts.warning} |`);
  lines.push(`| notice | ${counts.notice} |`);
  lines.push('');

  const a11yCount = (result.a11y ?? []).reduce((n, r) => n + r.violations.length, 0);
  const retireCount = (result.retire ?? []).reduce(
    (n, r) => n + r.findings.reduce((m, f) => m + f.vulnerabilities.length, 0),
    0,
  );
  const passiveCount = (result.passiveSecurity ?? []).reduce((n, r) => n + r.issues.length, 0);
  const touchCount = (result.touchTargets ?? []).reduce(
    (n, r) => n + r.tooSmall.length + r.overlapping.length,
    0,
  );
  const formsCount = (result.forms ?? []).reduce(
    (n, r) => n + r.forms.reduce((m, f) => m + f.issues.length, 0),
    0,
  );
  const keyboardCount = (result.keyboard ?? []).reduce((n, r) => n + r.issues.length, 0);
  const exposedCount = result.exposedPaths?.findings.length ?? 0;
  const consoleCount = (result.consoleErrors ?? []).reduce(
    (n, r) => n + r.issues.filter((i) => i.type === 'error' || i.type === 'pageerror' || i.type === 'unhandledrejection').length,
    0,
  );
  const budgetCount = result.budget?.length ?? 0;

  lines.push('## Breakdown');
  lines.push('');
  lines.push('| Check | Count |');
  lines.push('| --- | ---: |');
  lines.push(`| a11y violations | ${a11yCount} |`);
  lines.push(`| retire vulnerabilities | ${retireCount} |`);
  lines.push(`| passive-security | ${passiveCount} |`);
  lines.push(`| touch targets | ${touchCount} |`);
  lines.push(`| forms | ${formsCount} |`);
  lines.push(`| keyboard | ${keyboardCount} |`);
  lines.push(`| exposed paths | ${exposedCount} |`);
  lines.push(`| console errors | ${consoleCount} |`);
  lines.push(`| budget violations | ${budgetCount} |`);
  lines.push('');

  if (result.flows?.length) {
    const failed = result.flows.filter((f) => !f.passed).length;
    lines.push(`## Flows`);
    lines.push('');
    lines.push(`${result.flows.length} total, ${failed} failed`);
    lines.push('');
    for (const flow of result.flows) {
      lines.push(`- ${flow.passed ? 'pass' : 'fail'}: ${flow.name}${flow.error ? ` — ${oneLine(flow.error)}` : ''}`);
    }
    lines.push('');
  }

  if (!issues.length) {
    lines.push('No issues emitted.');
    lines.push('');
  }

  return lines.join('\n');
}

export async function writeSummary(result: InspectResult, path?: string): Promise<void> {
  const target = path ?? process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  const body = buildSummaryMarkdown(result);
  if (path) {
    await writeFile(target, body, 'utf8');
  } else {
    await appendFile(target, body.endsWith('\n') ? body : body + '\n', 'utf8');
  }
}
