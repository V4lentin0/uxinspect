export type FixLang = 'html' | 'css' | 'jsx' | 'vue' | 'attr';

export interface AutoFixPatch {
  issueId: string;
  category: 'a11y' | 'seo' | 'perf' | 'security' | 'forms' | 'images' | 'headings' | 'structured-data';
  severity: 'info' | 'warn' | 'error';
  selector?: string;
  before?: string;
  after?: string;
  lang: FixLang;
  rationale: string;
  confidence: number;
  docsRef?: string;
}

export interface A11yNode { html: string; target: string[]; }
export interface A11yViolation { id: string; impact: string; nodes: A11yNode[]; }
export interface IssueRecord { type: string; selector?: string; snippet?: string; }
export interface PageIssues { page: string; issues: IssueRecord[]; }

export interface AutoFixInput {
  a11y?: A11yViolation[];
  headings?: PageIssues[];
  forms?: PageIssues[];
  images?: PageIssues[];
}

interface Rule {
  category: AutoFixPatch['category'];
  severity: AutoFixPatch['severity'];
  lang: FixLang;
  rationale: string;
  confidence: number;
  docsRef?: string;
  build: (snippet: string | undefined) => { before: string; after: string };
}

function ensureAttr(snippet: string | undefined, attr: string, value: string): string {
  const fallback = `<element ${attr}="${value}"></element>`;
  if (!snippet) return fallback;
  const tagMatch = snippet.match(/^<([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/);
  if (!tagMatch) return snippet.replace(/<([a-zA-Z][a-zA-Z0-9-]*)/, `<$1 ${attr}="${value}"`);
  const [full, tag, attrs] = tagMatch;
  if (new RegExp(`\\b${attr}=`).test(attrs)) {
    const replaced = attrs.replace(new RegExp(`${attr}="[^"]*"`), `${attr}="${value}"`);
    return snippet.replace(full, `<${tag}${replaced}>`);
  }
  return snippet.replace(full, `<${tag}${attrs} ${attr}="${value}">`);
}

function wrapWithLabel(snippet: string | undefined, text: string): string {
  return `<label>${text} ${snippet ?? '<input type="text" name="field">'}</label>`;
}

function demoteHeading(snippet: string | undefined, from: number, to: number): string {
  if (!snippet) return `<h${to}>Section title</h${to}>`;
  return snippet
    .replace(new RegExp(`<h${from}([^>]*)>`, 'g'), `<h${to}$1>`)
    .replace(new RegExp(`</h${from}>`, 'g'), `</h${to}>`);
}

function severityFromImpact(impact: string): AutoFixPatch['severity'] {
  if (impact === 'critical' || impact === 'serious') return 'error';
  if (impact === 'moderate') return 'warn';
  return 'info';
}

function attrRule(
  category: AutoFixPatch['category'],
  severity: AutoFixPatch['severity'],
  fallbackBefore: string,
  attr: string,
  value: string,
  rationale: string,
  confidence: number,
  docsRef?: string,
  lang: FixLang = 'html',
): Rule {
  return {
    category, severity, lang, rationale, confidence, docsRef,
    build: (snippet) => ({
      before: snippet ?? fallbackBefore,
      after: ensureAttr(snippet ?? fallbackBefore, attr, value),
    }),
  };
}

function staticRule(
  category: AutoFixPatch['category'],
  severity: AutoFixPatch['severity'],
  before: string,
  after: string,
  rationale: string,
  confidence: number,
  docsRef?: string,
  lang: FixLang = 'html',
): Rule {
  return {
    category, severity, lang, rationale, confidence, docsRef,
    build: (snippet) => ({ before: snippet ?? before, after }),
  };
}

const A11Y_RULES: Record<string, Rule> = {
  'image-alt': attrRule('a11y', 'error', '<img src="foo.jpg">', 'alt', 'Description of image',
    'WCAG 1.1.1 — images need text alternatives so screen readers can describe them.', 0.7, 'WCAG 1.1.1'),
  'label': {
    category: 'a11y', severity: 'error', lang: 'html', confidence: 0.7, docsRef: 'WCAG 1.3.1, 4.1.2',
    rationale: 'Form controls need programmatically associated labels for assistive tech.',
    build: (s) => ({ before: s ?? '<input type="text" name="q">', after: wrapWithLabel(s, 'Search') }),
  },
  'color-contrast': staticRule('a11y', 'error',
    '.text { color: #999; background: #fff; }',
    '.text { color: #595959; background: #fff; } /* contrast ratio >= 4.5:1 */',
    'Increase foreground/background contrast to meet WCAG AA 4.5:1 for normal text.', 0.7, 'WCAG 1.4.3', 'css'),
  'heading-order': staticRule('a11y', 'warn',
    '<h1>Title</h1><h3>Sub</h3>', '<h1>Title</h1><h2>Sub</h2>',
    'Heading levels should not skip (h1 -> h3). Use sequential levels for outline clarity.', 0.95, 'WCAG 1.3.1'),
  'link-name': attrRule('a11y', 'error', '<a href="/x"><i class="icon"></i></a>',
    'aria-label', 'Descriptive link text',
    'Links must have discernible text for screen reader users.', 0.95, 'WCAG 2.4.4, 4.1.2'),
  'button-name': attrRule('a11y', 'error', '<button><i class="icon"></i></button>',
    'aria-label', 'Button purpose',
    'Buttons must have an accessible name describing their action.', 0.95, 'WCAG 4.1.2'),
  'html-has-lang': staticRule('a11y', 'error', '<html>', '<html lang="en">',
    'Root element needs lang attribute so assistive tech can pronounce content correctly.', 0.95, 'WCAG 3.1.1'),
  'html-lang-valid': staticRule('a11y', 'error', '<html lang="english">', '<html lang="en">',
    'lang attribute must use a valid BCP 47 language code.', 0.95, 'WCAG 3.1.1'),
  'document-title': staticRule('a11y', 'error', '<head></head>',
    '<head><title>Page title — Site name</title></head>',
    'Pages need a unique, descriptive title for orientation and tab labels.', 0.95, 'WCAG 2.4.2'),
  'duplicate-id': staticRule('a11y', 'error',
    '<div id="x"></div>...<div id="x"></div>', '<div id="x-1"></div>...<div id="x-2"></div>',
    'IDs must be unique within a document; duplicates break label/aria associations.', 0.95, 'WCAG 4.1.1'),
  'aria-roles': attrRule('a11y', 'error', '<div role="buton">', 'role', 'button',
    'role attribute must use a valid ARIA role from the spec.', 0.95, 'WCAG 4.1.2'),
  'aria-required-attr': attrRule('a11y', 'error', '<div role="checkbox"></div>',
    'aria-checked', 'false',
    'Elements with ARIA roles need their required ARIA attributes set.', 0.95, 'WAI-ARIA 1.2'),
  'aria-valid-attr-value': attrRule('a11y', 'error', '<div aria-expanded="yes">',
    'aria-expanded', 'true',
    'ARIA attributes must use valid values per the WAI-ARIA spec.', 0.95, 'WAI-ARIA 1.2'),
  'frame-title': attrRule('a11y', 'error', '<iframe src="/x"></iframe>',
    'title', 'Embedded content description',
    'Frames need a title attribute so users know what they contain.', 0.95, 'WCAG 2.4.1, 4.1.2'),
  'list': staticRule('a11y', 'warn', '<ul><div>item</div></ul>', '<ul><li>item</li></ul>',
    'ul/ol must contain only li (or script/template) children.', 0.95, 'WCAG 1.3.1'),
  'listitem': staticRule('a11y', 'warn', '<li>orphan</li>', '<ul><li>orphan</li></ul>',
    'li elements must be wrapped in a ul or ol parent.', 0.95, 'WCAG 1.3.1'),
  'meta-viewport': staticRule('a11y', 'error',
    '<meta name="viewport" content="user-scalable=no">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    'Disabling user-scalable blocks pinch-zoom and harms low-vision users.', 0.95, 'WCAG 1.4.4'),
  'tabindex': attrRule('a11y', 'warn', '<div tabindex="5">', 'tabindex', '0',
    'Avoid tabindex > 0; it disrupts natural tab order.', 0.95, 'WCAG 2.4.3'),
  'region': staticRule('a11y', 'warn', '<div>page content</div>', '<main>page content</main>',
    'Wrap primary page content in a landmark element so assistive tech can navigate.', 0.7, 'WCAG 1.3.1, 2.4.1'),
  'landmark-one-main': staticRule('a11y', 'warn',
    '<body><div>...</div></body>', '<body><main>...</main></body>',
    'Each page should have exactly one main landmark.', 0.95, 'WCAG 1.3.1'),
  'bypass': staticRule('a11y', 'warn',
    '<body><nav>...</nav><main>...</main></body>',
    '<body><a href="#main" class="skip-link">Skip to main content</a><nav>...</nav><main id="main">...</main></body>',
    'Provide a skip link so keyboard users can bypass repeated navigation.', 0.95, 'WCAG 2.4.1'),
};

const FORM_RULES: Record<string, Rule> = {
  'missing-label': {
    category: 'forms', severity: 'error', lang: 'html', confidence: 0.7, docsRef: 'WCAG 1.3.1, 3.3.2',
    rationale: 'Form controls need programmatically associated labels.',
    build: (s) => ({ before: s ?? '<input type="email" name="email">', after: wrapWithLabel(s, 'Email address') }),
  },
  'missing-autocomplete': {
    category: 'forms', severity: 'warn', lang: 'html', confidence: 0.95, docsRef: 'WCAG 1.3.5',
    rationale: 'Autocomplete tokens help users (and password managers) fill known data.',
    build: (s) => {
      const snip = s ?? '<input type="email" name="email">';
      const guess = /email/i.test(snip) ? 'email' : /tel|phone/i.test(snip) ? 'tel' : /name/i.test(snip) ? 'name' : 'on';
      return { before: snip, after: ensureAttr(snip, 'autocomplete', guess) };
    },
  },
  'missing-required-indicator': attrRule('forms', 'warn', '<input required>', 'aria-required', 'true',
    'Required fields should be visually and programmatically indicated.', 0.95, 'WCAG 3.3.2'),
  'missing-error-message': staticRule('forms', 'error',
    '<input aria-invalid="true">',
    '<input aria-invalid="true" aria-describedby="err-1"><span id="err-1" role="alert">Please enter a valid value.</span>',
    'Invalid inputs should reference a visible error message via aria-describedby.', 0.95, 'WCAG 3.3.1, 3.3.3'),
  'missing-fieldset': staticRule('forms', 'warn',
    '<input type="radio" name="r"><input type="radio" name="r">',
    '<fieldset><legend>Choose one</legend><input type="radio" name="r"><input type="radio" name="r"></fieldset>',
    'Group related radio/checkbox controls in a fieldset with a legend.', 0.95, 'WCAG 1.3.1'),
  'missing-input-mode': attrRule('forms', 'info', '<input type="text" name="otp">',
    'inputmode', 'numeric',
    'Set inputmode to surface the right virtual keyboard on mobile.', 0.7),
  'submit-without-button': staticRule('forms', 'warn',
    '<form>...</form>', '<form>...<button type="submit">Submit</button></form>',
    'Forms should have an explicit submit button for keyboard users.', 0.95, 'WCAG 2.1.1'),
};

const HEADING_RULES: Record<string, Rule> = {
  'multiple-h1': {
    category: 'headings', severity: 'warn', lang: 'html', confidence: 0.95, docsRef: 'WCAG 1.3.1, 2.4.6',
    rationale: 'Each page should have a single h1 representing its main topic.',
    build: (s) => ({
      before: s ?? '<h1>Primary</h1>...<h1>Secondary</h1>',
      after: demoteHeading(s ?? '<h1>Secondary</h1>', 1, 2),
    }),
  },
  'missing-h1': staticRule('headings', 'error', '<body><h2>Welcome</h2></body>', '<body><h1>Welcome</h1></body>',
    'Pages need a top-level h1 to anchor the document outline.', 0.95, 'WCAG 2.4.6'),
  'skipped-level': staticRule('headings', 'warn',
    '<h1>Title</h1><h3>Sub</h3>', '<h1>Title</h1><h2>Sub</h2>',
    'Heading levels should not skip; promote h3 to h2 to maintain hierarchy.', 0.95, 'WCAG 1.3.1'),
  'empty-heading': staticRule('headings', 'error', '<h2></h2>', '<h2>Section title</h2>',
    'Empty headings confuse screen reader navigation; remove or fill them.', 0.7, 'WCAG 1.3.1, 2.4.6'),
};

const IMAGE_RULES: Record<string, Rule> = {
  'missing-alt': attrRule('images', 'error', '<img src="hero.jpg">', 'alt', 'Describe the image content',
    'Add alt text for informative images, or alt="" for decorative ones.', 0.7, 'WCAG 1.1.1'),
  'decorative-needs-empty-alt': attrRule('images', 'warn', '<img src="bg.svg">', 'alt', '',
    'Decorative images should have alt="" so screen readers skip them.', 0.95, 'WCAG 1.1.1'),
  'missing-dimensions': {
    category: 'images', severity: 'warn', lang: 'html', confidence: 0.95, docsRef: 'web.dev/optimize-cls',
    rationale: 'Width/height attributes prevent layout shift (CLS) while images load.',
    build: (s) => {
      const snip = s ?? '<img src="hero.jpg" alt="Hero">';
      return { before: snip, after: ensureAttr(ensureAttr(snip, 'width', '1200'), 'height', '630') };
    },
  },
  'missing-lazy': attrRule('images', 'info', '<img src="below-fold.jpg" alt="">',
    'loading', 'lazy',
    'Lazy-load below-the-fold images to defer network and decode work.', 0.95,
    'web.dev/browser-level-image-lazy-loading'),
  'wrong-format': staticRule('images', 'info',
    '<img src="hero.png" alt="Hero">',
    '<picture><source type="image/avif" srcset="hero.avif"><source type="image/webp" srcset="hero.webp"><img src="hero.png" alt="Hero" width="1200" height="630"></picture>',
    'Serve modern formats (AVIF/WebP) with picture for smaller payloads.', 0.7, 'web.dev/serve-images-webp'),
  'missing-srcset': {
    category: 'images', severity: 'info', lang: 'html', confidence: 0.7, docsRef: 'web.dev/serve-responsive-images',
    rationale: 'Provide srcset/sizes so the browser picks the best resolution per device.',
    build: (s) => {
      const snip = s ?? '<img src="hero.jpg" alt="Hero">';
      const withSrcset = ensureAttr(snip, 'srcset', 'hero-800.jpg 800w, hero-1600.jpg 1600w');
      return { before: snip, after: ensureAttr(withSrcset, 'sizes', '(max-width: 800px) 100vw, 800px') };
    },
  },
  'missing-eager-lcp': {
    category: 'images', severity: 'warn', lang: 'html', confidence: 0.95, docsRef: 'web.dev/optimize-lcp',
    rationale: 'LCP image should load eagerly with high fetch priority to improve LCP.',
    build: (s) => {
      const snip = s ?? '<img src="hero.jpg" alt="Hero">';
      return { before: snip, after: ensureAttr(ensureAttr(snip, 'fetchpriority', 'high'), 'loading', 'eager') };
    },
  },
  'svg-missing-title': staticRule('images', 'warn',
    '<svg viewBox="0 0 24 24"><path d="..."/></svg>',
    '<svg viewBox="0 0 24 24" role="img" aria-labelledby="t1"><title id="t1">Icon description</title><path d="..."/></svg>',
    'Inline SVGs need a title (and role="img") so screen readers announce them.', 0.95, 'WCAG 1.1.1'),
};

const STRUCTURED_DATA_TEMPLATE = `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "WebSite",
  "name": "Site name",
  "url": "https://example.com"
}
</script>`;

function makePatch(rule: Rule, issueId: string, selector: string | undefined, snippet: string | undefined): AutoFixPatch {
  const built = rule.build(snippet);
  return {
    issueId,
    category: rule.category,
    severity: rule.severity,
    selector,
    before: built.before,
    after: built.after,
    lang: rule.lang,
    rationale: rule.rationale,
    confidence: rule.confidence,
    docsRef: rule.docsRef,
  };
}

export function generateAutoFixes(input: AutoFixInput): AutoFixPatch[] {
  const patches: AutoFixPatch[] = [];

  if (input.a11y) {
    input.a11y.forEach((violation, vIdx) => {
      const rule = A11Y_RULES[violation.id];
      if (!rule) return;
      violation.nodes.forEach((node, nIdx) => {
        const selector = node.target.join(' ');
        const patch = makePatch(rule, `a11y:${violation.id}:${vIdx}-${nIdx}`, selector, node.html);
        patch.severity = severityFromImpact(violation.impact);
        patches.push(patch);
      });
    });
  }

  const collect = (pages: PageIssues[] | undefined, rules: Record<string, Rule>, prefix: string): void => {
    if (!pages) return;
    pages.forEach((page) => {
      page.issues.forEach((issue, idx) => {
        const rule = rules[issue.type];
        if (!rule) return;
        const id = `${prefix}:${page.page}:${issue.type}:${idx}`;
        patches.push(makePatch(rule, id, issue.selector, issue.snippet));
      });
    });
  };

  collect(input.headings, HEADING_RULES, 'headings');
  collect(input.forms, FORM_RULES, 'forms');
  collect(input.images, IMAGE_RULES, 'images');

  if (!patches.some((p) => p.category === 'structured-data')) {
    patches.push({
      issueId: 'structured-data:missing-website:0',
      category: 'structured-data',
      severity: 'info',
      lang: 'html',
      before: '<head>...</head>',
      after: `<head>...${STRUCTURED_DATA_TEMPLATE}</head>`,
      rationale: 'Add WebSite JSON-LD so search engines understand the site identity.',
      confidence: 0.7,
      docsRef: 'schema.org/WebSite',
    });
  }

  return patches;
}

function fence(lang: FixLang, body: string | undefined): string {
  if (!body) return '';
  const tag = lang === 'attr' ? 'html' : lang;
  return '```' + tag + '\n' + body + '\n```';
}

export function autoFixesToMarkdown(patches: AutoFixPatch[]): string {
  return patches.map((patch) => {
    const lines: string[] = [];
    lines.push(`### ${patch.category}: ${patch.issueId}`);
    lines.push('');
    lines.push(`**${patch.severity}** | confidence ${patch.confidence}`);
    lines.push('');
    if (patch.selector) {
      lines.push(`Selector: \`${patch.selector}\``);
      lines.push('');
    }
    if (patch.before) {
      lines.push('**Before:**');
      lines.push(fence(patch.lang, patch.before));
      lines.push('');
    }
    if (patch.after) {
      lines.push('**After:**');
      lines.push(fence(patch.lang, patch.after));
      lines.push('');
    }
    lines.push(`**Why:** ${patch.rationale}`);
    if (patch.docsRef) {
      lines.push('');
      lines.push(`Reference: ${patch.docsRef}`);
    }
    return lines.join('\n');
  }).join('\n\n');
}
