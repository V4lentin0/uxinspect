import type { Page } from 'playwright';

export type BotBlockType =
  | 'captcha-present'
  | 'cloudflare-challenge'
  | 'perimeter-x'
  | 'datadome'
  | 'akamai-bot-manager'
  | 'ua-sniffing'
  | 'webdriver-check'
  | 'automation-flag-check';

export interface BotBlockSignal {
  type: BotBlockType;
  evidence: string;
}

export type HeadlessIssueType = 'site-blocks-headless' | 'site-fingerprints';

export interface HeadlessIssue {
  type: HeadlessIssueType;
  detail: string;
}

export interface HeadlessDetectResult {
  page: string;
  botBlockSignals: BotBlockSignal[];
  fingerprintingApis: string[];
  headlessUaInDocument: boolean;
  challengePagesDetected: boolean;
  issues: HeadlessIssue[];
  passed: boolean;
}

interface HeadlessSnapshot {
  htmlSlice: string;
  scriptsText: string;
  cookieString: string;
  title: string;
  hasPxGlobal: boolean;
}

const HTML_SCAN_LIMIT = 200 * 1024;
const SCRIPT_SCAN_LIMIT = 100 * 1024;

export async function auditHeadlessDetect(page: Page): Promise<HeadlessDetectResult> {
  const pageUrl = page.url();

  const snapshot = await page.evaluate(
    ({ htmlLimit, scriptLimit }): HeadlessSnapshot => {
      const rawHtml = document.documentElement?.outerHTML ?? '';
      const htmlSlice = rawHtml.length > htmlLimit ? rawHtml.slice(0, htmlLimit) : rawHtml;

      const scriptNodes = Array.from(document.querySelectorAll('script'));
      let scriptsText = '';
      for (const node of scriptNodes) {
        if (scriptsText.length >= scriptLimit) break;
        const src = node.getAttribute('src');
        if (src) scriptsText += ' ' + src;
        const inline = node.textContent;
        if (inline) scriptsText += ' ' + inline;
      }
      if (scriptsText.length > scriptLimit) scriptsText = scriptsText.slice(0, scriptLimit);

      const pxGlobal =
        typeof (window as unknown as Record<string, unknown>)['_px'] !== 'undefined' ||
        typeof (window as unknown as Record<string, unknown>)['_pxAppId'] !== 'undefined';

      return {
        htmlSlice,
        scriptsText,
        cookieString: document.cookie ?? '',
        title: document.title ?? '',
        hasPxGlobal: pxGlobal,
      };
    },
    { htmlLimit: HTML_SCAN_LIMIT, scriptLimit: SCRIPT_SCAN_LIMIT },
  );

  const botBlockSignals: BotBlockSignal[] = [];
  const fingerprintingApis: string[] = [];

  const html = snapshot.htmlSlice;
  const htmlLower = html.toLowerCase();
  const scripts = snapshot.scriptsText;
  const scriptsLower = scripts.toLowerCase();
  const cookies = snapshot.cookieString;
  const cookiesLower = cookies.toLowerCase();
  const titleLower = snapshot.title.toLowerCase();

  const captchaMatchers: Array<{ needle: string; label: string }> = [
    { needle: 'hcaptcha.com', label: 'hCaptcha iframe/script reference found in document' },
    { needle: 'recaptcha', label: 'reCAPTCHA reference found in document' },
    { needle: 'turnstile', label: 'Cloudflare Turnstile reference found in document' },
    { needle: 'arkoselabs.com', label: 'Arkose Labs reference found in document' },
  ];
  for (const { needle, label } of captchaMatchers) {
    if (htmlLower.includes(needle)) {
      botBlockSignals.push({ type: 'captcha-present', evidence: label });
    }
  }

  const cloudflareEvidence: string[] = [];
  if (htmlLower.includes('cf-browser-verification')) {
    cloudflareEvidence.push('class "cf-browser-verification" present');
  }
  if (htmlLower.includes('checking your browser')) {
    cloudflareEvidence.push('"Checking your browser" text present');
  }
  if (htmlLower.includes('challenges.cloudflare.com')) {
    cloudflareEvidence.push('challenges.cloudflare.com script referenced');
  }
  for (const evidence of cloudflareEvidence) {
    botBlockSignals.push({ type: 'cloudflare-challenge', evidence });
  }

  if (scriptsLower.includes('perimeterx.net')) {
    botBlockSignals.push({
      type: 'perimeter-x',
      evidence: 'perimeterx.net script reference found',
    });
  }
  if (snapshot.hasPxGlobal) {
    botBlockSignals.push({
      type: 'perimeter-x',
      evidence: 'PerimeterX global (_px / _pxAppId) defined on window',
    });
  }

  if (scriptsLower.includes('datadome.co') || htmlLower.includes('datadome.co')) {
    botBlockSignals.push({
      type: 'datadome',
      evidence: 'datadome.co reference found in document',
    });
  }
  if (cookiesLower.includes('dd_cookie_test_') || cookiesLower.includes('datadome=')) {
    botBlockSignals.push({
      type: 'datadome',
      evidence: 'DataDome cookie present',
    });
  }

  if (cookiesLower.includes('_abck=') || cookiesLower.includes('bm_sz=')) {
    botBlockSignals.push({
      type: 'akamai-bot-manager',
      evidence: 'Akamai Bot Manager cookie (_abck / bm_sz) present',
    });
  }
  if (scriptsLower.includes('/akam/') || scriptsLower.includes('akamai')) {
    botBlockSignals.push({
      type: 'akamai-bot-manager',
      evidence: 'Akamai script path referenced',
    });
  }

  if (scriptsLower.includes('navigator.webdriver')) {
    botBlockSignals.push({
      type: 'webdriver-check',
      evidence: 'Inline script references navigator.webdriver',
    });
  }
  if (
    scriptsLower.includes('navigator.useragent') &&
    (scriptsLower.includes('headless') || scriptsLower.includes('phantom') || scriptsLower.includes('bot'))
  ) {
    botBlockSignals.push({
      type: 'ua-sniffing',
      evidence: 'Inline script inspects navigator.userAgent for headless/bot tokens',
    });
  }
  if (
    scriptsLower.includes('window.chrome') &&
    (scriptsLower.includes('headless') || scriptsLower.includes('automation'))
  ) {
    botBlockSignals.push({
      type: 'automation-flag-check',
      evidence: 'Inline script probes window.chrome / automation flag',
    });
  }

  const fingerprintLibs: Array<{ needle: string; label: string }> = [
    { needle: 'fingerprintjs', label: 'fingerprintjs' },
    { needle: 'clientjs', label: 'clientjs' },
    { needle: 'imprint', label: 'imprint' },
  ];
  for (const { needle, label } of fingerprintLibs) {
    if (scriptsLower.includes(needle) || htmlLower.includes(needle)) {
      if (!fingerprintingApis.includes(label)) fingerprintingApis.push(label);
    }
  }

  const hasAnyBotSignal = botBlockSignals.some(
    (s) =>
      s.type === 'cloudflare-challenge' ||
      s.type === 'captcha-present' ||
      s.type === 'datadome' ||
      s.type === 'akamai-bot-manager',
  );
  const challengeTitleMatch =
    titleLower.includes('attention required') ||
    titleLower.includes('just a moment') ||
    titleLower.includes('access denied');
  const challengeBodyMatch = htmlLower.includes('verifying you are human');
  const challengePagesDetected = hasAnyBotSignal && (challengeTitleMatch || challengeBodyMatch);

  const headlessUaInDocument =
    scriptsLower.includes('headlesschrome') || scriptsLower.includes('navigator.webdriver');

  const issues: HeadlessIssue[] = [];
  if (botBlockSignals.length > 0 && challengePagesDetected) {
    const types = Array.from(new Set(botBlockSignals.map((s) => s.type))).join(', ');
    issues.push({
      type: 'site-blocks-headless',
      detail: `Site appears to be serving a bot-block/challenge page (${types}). Headless runs may be throttled or blocked.`,
    });
  }
  if (fingerprintingApis.length > 0) {
    issues.push({
      type: 'site-fingerprints',
      detail: `Site loads fingerprinting library/libraries: ${fingerprintingApis.join(', ')}.`,
    });
  }

  const passed = challengePagesDetected === false;

  return {
    page: pageUrl,
    botBlockSignals,
    fingerprintingApis,
    headlessUaInDocument,
    challengePagesDetected,
    issues,
    passed,
  };
}
