import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export interface InitAnswers {
  url: string;
  viewports: Array<'mobile' | 'tablet' | 'desktop'>;
  checks: {
    a11y?: boolean;
    perf?: boolean;
    visual?: boolean;
    seo?: boolean;
    security?: boolean;
    links?: boolean;
    consoleErrors?: boolean;
    forms?: boolean;
    deadImages?: boolean;
    headings?: boolean;
  };
  generateWorkflow?: boolean;
  reportDir?: string;
  browsers?: Array<'chromium' | 'firefox' | 'webkit'>;
}

export interface InitResult {
  configPath: string;
  workflowPath?: string;
  gitignoreUpdated: boolean;
  warnings: string[];
}

type CheckKey = keyof InitAnswers['checks'];

const CHECK_KEYS: CheckKey[] = [
  'a11y',
  'perf',
  'visual',
  'seo',
  'security',
  'links',
  'consoleErrors',
  'forms',
  'deadImages',
  'headings',
];

const CHECK_LABELS: Record<CheckKey, string> = {
  a11y: 'accessibility',
  perf: 'performance',
  visual: 'visual regression',
  seo: 'SEO',
  security: 'security',
  links: 'broken links',
  consoleErrors: 'console errors',
  forms: 'forms audit',
  deadImages: 'dead images',
  headings: 'heading hierarchy',
};

const VIEWPORT_DIMS: Record<'mobile' | 'tablet' | 'desktop', { width: number; height: number }> = {
  mobile: { width: 375, height: 667 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 },
};

const GITIGNORE_LINES = ['uxinspect-report/', 'uxinspect-baselines/', '.uxinspect/'];

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readPackageJson(cwd: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(join(cwd, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function preferTypeScript(pkg: Record<string, unknown> | null): boolean {
  if (!pkg) return true;
  const deps = (pkg['dependencies'] as Record<string, unknown> | undefined) ?? {};
  const devDeps = (pkg['devDependencies'] as Record<string, unknown> | undefined) ?? {};
  const hasTs = 'typescript' in deps || 'typescript' in devDeps;
  const typeField = pkg['type'];
  if (typeField !== 'module' && !hasTs) return false;
  return true;
}

function parseViewports(raw: string): Array<'mobile' | 'tablet' | 'desktop'> {
  const valid: Array<'mobile' | 'tablet' | 'desktop'> = [];
  const parts = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  for (const p of parts) {
    if (p === 'mobile' || p === 'tablet' || p === 'desktop') {
      if (!valid.includes(p)) valid.push(p);
    }
  }
  return valid;
}

function isValidUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function yesNo(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return v === 'y' || v === 'yes';
}

function hasRequiredAnswers(a: Partial<InitAnswers> | undefined): a is InitAnswers {
  if (!a) return false;
  if (typeof a.url !== 'string' || !isValidUrl(a.url)) return false;
  if (!a.checks || typeof a.checks !== 'object') return false;
  const anyCheckEnabled = CHECK_KEYS.some((k) => a.checks?.[k] === true);
  if (!anyCheckEnabled) return false;
  return true;
}

async function promptInteractive(partial: Partial<InitAnswers>): Promise<InitAnswers> {
  const rl = readline.createInterface({ input, output });
  try {
    let url = partial.url;
    while (!url || !isValidUrl(url)) {
      const answer = await rl.question('What URL to audit? ');
      if (isValidUrl(answer)) {
        url = answer.trim();
        break;
      }
      output.write('Please enter a valid http(s) URL.\n');
    }

    let viewports = partial.viewports ?? [];
    if (viewports.length === 0) {
      const vpRaw = await rl.question('Which viewports? (comma-sep: mobile,tablet,desktop) [desktop] ');
      const parsed = parseViewports(vpRaw);
      viewports = parsed.length > 0 ? parsed : ['desktop'];
    }

    const checks: InitAnswers['checks'] = { ...(partial.checks ?? {}) };
    for (const key of CHECK_KEYS) {
      if (typeof checks[key] === 'boolean') continue;
      const label = CHECK_LABELS[key];
      const ans = await rl.question(`Enable ${label}? (y/N) `);
      checks[key] = yesNo(ans);
    }

    let generateWorkflow = partial.generateWorkflow;
    if (typeof generateWorkflow !== 'boolean') {
      const ans = await rl.question('Generate CI workflow? (y/N) ');
      generateWorkflow = yesNo(ans);
    }

    const reportDir = partial.reportDir ?? 'uxinspect-report';
    const browsers = partial.browsers;

    return { url, viewports, checks, generateWorkflow, reportDir, browsers };
  } finally {
    rl.close();
  }
}

function formatViewports(viewports: Array<'mobile' | 'tablet' | 'desktop'>): string {
  const list: Array<'mobile' | 'tablet' | 'desktop'> = viewports.length > 0 ? viewports : ['desktop'];
  const entries = list.map((name) => {
    const dims = VIEWPORT_DIMS[name];
    return `    { width: ${dims.width}, height: ${dims.height} }`;
  });
  return `[\n${entries.join(',\n')},\n  ]`;
}

function formatChecks(checks: InitAnswers['checks']): string {
  const enabled: Record<string, boolean> = {};
  for (const key of CHECK_KEYS) {
    if (checks[key]) enabled[key] = true;
  }
  const json = JSON.stringify(enabled, null, 2);
  return json
    .split('\n')
    .map((line, idx) => (idx === 0 ? line : `  ${line}`))
    .join('\n');
}

function formatBrowsers(browsers: Array<'chromium' | 'firefox' | 'webkit'> | undefined): string | null {
  if (!browsers || browsers.length === 0) return null;
  const first = browsers[0];
  return `  browser: '${first}',`;
}

export function generateConfigFile(answers: InitAnswers): string {
  const viewportsBlock = formatViewports(answers.viewports);
  const checksBlock = formatChecks(answers.checks);
  const reportDir = answers.reportDir ?? 'uxinspect-report';
  const browserLine = formatBrowsers(answers.browsers);
  const lines: string[] = [];
  lines.push(`import type { InspectConfig } from 'uxinspect';`);
  lines.push('');
  lines.push('const config: InspectConfig = {');
  lines.push(`  url: ${JSON.stringify(answers.url)},`);
  lines.push(`  viewports: ${viewportsBlock},`);
  lines.push(`  checks: ${checksBlock},`);
  if (browserLine) lines.push(browserLine);
  lines.push(`  output: { dir: ${JSON.stringify(reportDir)} },`);
  lines.push('};');
  lines.push('');
  lines.push('export default config;');
  lines.push('');
  return lines.join('\n');
}

export function generateWorkflowFile(answers: InitAnswers): string {
  const reportDir = answers.reportDir ?? 'uxinspect-report';
  return [
    'name: uxinspect',
    'on: [pull_request]',
    'jobs:',
    '  audit:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    `        with: { node-version: '20' }`,
    '      - run: npx playwright install --with-deps chromium',
    '      - run: npx uxinspect',
    '      - uses: actions/upload-artifact@v4',
    '        if: always()',
    '        with:',
    '          name: uxinspect-report',
    `          path: ${reportDir}`,
    '',
  ].join('\n');
}

async function updateGitignore(cwd: string): Promise<boolean> {
  const gitignorePath = join(cwd, '.gitignore');
  let existing = '';
  let existed = false;
  try {
    existing = await readFile(gitignorePath, 'utf8');
    existed = true;
  } catch {
    existing = '';
  }
  const currentLines = existing.split('\n').map((l) => l.trim());
  const toAdd = GITIGNORE_LINES.filter((line) => !currentLines.includes(line));
  if (toAdd.length === 0) return false;
  const needsLeadingNewline = existed && existing.length > 0 && !existing.endsWith('\n');
  const prefix = needsLeadingNewline ? '\n' : '';
  const block = `${prefix}${toAdd.join('\n')}\n`;
  await writeFile(gitignorePath, existing + block, 'utf8');
  return true;
}

export async function runInitWizard(opts?: {
  cwd?: string;
  answers?: Partial<InitAnswers>;
  overwrite?: boolean;
}): Promise<InitResult> {
  const cwd = opts?.cwd ?? process.cwd();
  const overwrite = opts?.overwrite === true;
  const warnings: string[] = [];

  const pkg = await readPackageJson(cwd);
  const useTs = preferTypeScript(pkg);
  const configFilename = useTs ? 'uxinspect.config.ts' : 'uxinspect.config.js';
  const configPath = join(cwd, configFilename);

  const provided = opts?.answers;
  const answers: InitAnswers = hasRequiredAnswers(provided)
    ? {
        url: provided.url,
        viewports: provided.viewports.length > 0 ? provided.viewports : ['desktop'],
        checks: provided.checks,
        generateWorkflow: provided.generateWorkflow ?? false,
        reportDir: provided.reportDir ?? 'uxinspect-report',
        browsers: provided.browsers,
      }
    : await promptInteractive(provided ?? {});

  const configExists = await pathExists(configPath);
  if (configExists && !overwrite) {
    warnings.push(`Config file already exists at ${configPath}; skipped write. Pass overwrite: true to replace.`);
  } else {
    await writeFile(configPath, generateConfigFile(answers), 'utf8');
  }

  let workflowPath: string | undefined;
  if (answers.generateWorkflow) {
    const wfDir = join(cwd, '.github', 'workflows');
    const wfPath = join(wfDir, 'uxinspect.yml');
    const wfExists = await pathExists(wfPath);
    if (wfExists && !overwrite) {
      warnings.push(`Workflow file already exists at ${wfPath}; skipped write.`);
      workflowPath = wfPath;
    } else {
      await mkdir(wfDir, { recursive: true });
      await writeFile(wfPath, generateWorkflowFile(answers), 'utf8');
      workflowPath = wfPath;
    }
  }

  const gitignoreUpdated = await updateGitignore(cwd);

  const result: InitResult = {
    configPath,
    gitignoreUpdated,
    warnings,
  };
  if (workflowPath !== undefined) result.workflowPath = workflowPath;
  return result;
}

// Unused-import guard for dirname (kept for future relative-path helpers).
void dirname;
