import type { Page } from 'playwright';

export interface AmpIssue {
  type:
    | 'missing-html-amp-attr'
    | 'too-large'
    | 'missing-required-tag'
    | 'discouraged-tag'
    | 'custom-script'
    | 'missing-canonical'
    | 'missing-viewport';
  detail: string;
}

export interface AmpCustomScript {
  src?: string;
  inline: boolean;
}

export interface AmpRequiredTags {
  html: boolean;
  head: boolean;
  charset: boolean;
  viewport: boolean;
  ampScript: boolean;
  ampBoilerplate: boolean;
  canonical: boolean;
}

export interface AmpResult {
  page: string;
  isAmp: boolean;
  ampVersion?: string;
  ampHtmlSize: number;
  requiredTagsPresent: AmpRequiredTags;
  discouragedTags: string[];
  customScripts: AmpCustomScript[];
  ampComponents: string[];
  issues: AmpIssue[];
  passed: boolean;
}

const MAX_AMP_SIZE = 75 * 1024;

const DISCOURAGED_TAG_NAMES = ['form', 'embed', 'frame', 'object', 'param', 'applet'] as const;

interface EvaluatedAmp {
  isAmp: boolean;
  ampVersion?: string;
  ampHtmlSize: number;
  requiredTagsPresent: AmpRequiredTags;
  discouragedTags: string[];
  customScripts: AmpCustomScript[];
  ampComponents: string[];
}

export async function validateAmp(page: Page): Promise<AmpResult> {
  const url = page.url();

  const data: EvaluatedAmp = await page.evaluate(() => {
    const html = document.documentElement;
    const isAmp = html.hasAttribute('amp') || html.hasAttribute('\u26A1');

    const ampRuntimeScript = document.querySelector<HTMLScriptElement>(
      'script[src*="cdn.ampproject.org/v0.js"]',
    );

    let ampVersion: string | undefined;
    if (ampRuntimeScript) {
      const src = ampRuntimeScript.getAttribute('src') || '';
      const match = src.match(/cdn\.ampproject\.org\/(v\d+(?:\.\d+)*)\.js/);
      if (match) ampVersion = match[1];
      else ampVersion = 'v0';
    }
    if (!ampVersion) {
      const versionMeta = document.querySelector<HTMLMetaElement>(
        'meta[name="amp-version"], meta[name="generator"][content*="AMP"]',
      );
      if (versionMeta) {
        const content = versionMeta.getAttribute('content') || '';
        const m = content.match(/v?\d+(?:\.\d+)*/);
        if (m) ampVersion = m[0];
      }
    }

    const ampHtmlSize = html.outerHTML.length;

    const hasHtml = !!document.documentElement;
    const hasHead = !!document.head;
    const hasCharset = !!document.querySelector('meta[charset]');
    const viewportMeta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const hasViewport =
      !!viewportMeta && /width\s*=\s*device-width/i.test(viewportMeta.getAttribute('content') || '');
    const hasAmpScript =
      !!document.querySelector(
        'script[async][src="https://cdn.ampproject.org/v0.js"]',
      ) || !!ampRuntimeScript;
    const hasAmpBoilerplate =
      !!document.querySelector('style[amp-boilerplate]') ||
      !!document.querySelector('style[\u26A1-boilerplate]');
    const hasCanonical = !!document.querySelector('link[rel="canonical"][href]');

    const discouragedTagNames = ['form', 'embed', 'frame', 'object', 'param', 'applet'];
    const discouragedTags: string[] = [];

    for (const tagName of discouragedTagNames) {
      const elements = Array.from(document.querySelectorAll(tagName));
      for (const el of elements) {
        if (tagName === 'form') {
          const actionXhr = el.getAttribute('action-xhr');
          if (actionXhr) continue;
        }
        discouragedTags.push(tagName);
      }
    }

    const iframes = Array.from(document.querySelectorAll('iframe'));
    for (const iframe of iframes) {
      const tagLocalName = iframe.tagName.toLowerCase();
      if (!tagLocalName.startsWith('amp-')) {
        discouragedTags.push('iframe');
      }
    }

    const scripts = Array.from(document.querySelectorAll('script'));
    const customScripts: AmpCustomScript[] = [];
    for (const script of scripts) {
      const src = script.getAttribute('src') || '';
      const type = (script.getAttribute('type') || '').toLowerCase();
      const customElement = script.getAttribute('custom-element') || '';
      const customTemplate = script.getAttribute('custom-template') || '';

      const isAmpRuntime = /cdn\.ampproject\.org\//.test(src);
      const isAmpComponentScript = isAmpRuntime && (customElement || customTemplate);
      const isJsonLd = type === 'application/ld+json';
      const isAmpMustache = type === 'text/plain' && customTemplate.startsWith('amp-');
      const isAmpJsonConfig =
        type === 'application/json' &&
        (!!script.closest('[id^="amp-"]') ||
          !!script.closest('amp-state') ||
          !!script.parentElement?.tagName.toLowerCase().startsWith('amp-'));

      if (isAmpRuntime || isAmpComponentScript || isJsonLd || isAmpMustache || isAmpJsonConfig) {
        continue;
      }

      const inline = !src;
      const entry: AmpCustomScript = { inline };
      if (src) entry.src = src;
      customScripts.push(entry);
    }

    const componentSet = new Set<string>();
    const allElements = document.getElementsByTagName('*');
    for (let i = 0; i < allElements.length; i++) {
      const tag = allElements[i].tagName.toLowerCase();
      if (tag.startsWith('amp-')) componentSet.add(tag);
    }
    const ampComponents = Array.from(componentSet).sort();

    const requiredTagsPresent: AmpRequiredTags = {
      html: hasHtml,
      head: hasHead,
      charset: hasCharset,
      viewport: hasViewport,
      ampScript: hasAmpScript,
      ampBoilerplate: hasAmpBoilerplate,
      canonical: hasCanonical,
    };

    return {
      isAmp,
      ampVersion,
      ampHtmlSize,
      requiredTagsPresent,
      discouragedTags,
      customScripts,
      ampComponents,
    };
  });

  const issues: AmpIssue[] = [];

  if (!data.isAmp) {
    issues.push({
      type: 'missing-html-amp-attr',
      detail: 'Root <html> element is missing the "amp" or "\u26A1" attribute',
    });
  }

  if (data.ampHtmlSize > MAX_AMP_SIZE) {
    issues.push({
      type: 'too-large',
      detail: `AMP HTML document is ${data.ampHtmlSize} bytes (max ${MAX_AMP_SIZE} bytes)`,
    });
  }

  const required = data.requiredTagsPresent;
  const requiredLabels: { key: keyof AmpRequiredTags; label: string }[] = [
    { key: 'html', label: '<html>' },
    { key: 'head', label: '<head>' },
    { key: 'charset', label: '<meta charset>' },
    { key: 'ampScript', label: '<script async src="https://cdn.ampproject.org/v0.js">' },
    { key: 'ampBoilerplate', label: '<style amp-boilerplate>' },
  ];
  for (const { key, label } of requiredLabels) {
    if (!required[key]) {
      issues.push({
        type: 'missing-required-tag',
        detail: `Required AMP tag missing: ${label}`,
      });
    }
  }

  if (!required.viewport) {
    issues.push({
      type: 'missing-viewport',
      detail: 'Missing <meta name="viewport" content="width=device-width...">',
    });
  }

  if (!required.canonical) {
    issues.push({
      type: 'missing-canonical',
      detail: 'Missing <link rel="canonical"> tag',
    });
  }

  const uniqueDiscouraged = Array.from(new Set(data.discouragedTags));
  for (const tag of uniqueDiscouraged) {
    const count = data.discouragedTags.filter((t) => t === tag).length;
    issues.push({
      type: 'discouraged-tag',
      detail: `Forbidden tag in AMP: <${tag}> (${count} occurrence${count === 1 ? '' : 's'})`,
    });
  }

  for (const script of data.customScripts) {
    issues.push({
      type: 'custom-script',
      detail: script.inline
        ? 'Inline <script> is forbidden in AMP'
        : `Custom <script src="${script.src}"> is forbidden in AMP`,
    });
  }

  const passed = data.isAmp && issues.length === 0;

  return {
    page: url,
    isAmp: data.isAmp,
    ampVersion: data.ampVersion,
    ampHtmlSize: data.ampHtmlSize,
    requiredTagsPresent: data.requiredTagsPresent,
    discouragedTags: uniqueDiscouraged,
    customScripts: data.customScripts,
    ampComponents: data.ampComponents,
    issues,
    passed,
  };
}
