import { writeFile } from 'node:fs/promises';

export interface JsonSchema {
  $schema?: string;
  $id?: string;
  $ref?: string;
  title?: string;
  description?: string;
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema | JsonSchema[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  definitions?: Record<string, JsonSchema>;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  format?: string;
  default?: unknown;
  examples?: unknown[];
}

type CheckOptsProps = Record<string, JsonSchema>;

function obj(properties: Record<string, JsonSchema>, required?: string[], additional = false): JsonSchema {
  const s: JsonSchema = { type: 'object', properties };
  if (required && required.length) s.required = required;
  s.additionalProperties = additional;
  return s;
}

function boolOrOpts(optsProps?: CheckOptsProps): JsonSchema {
  if (!optsProps) return { type: 'boolean' };
  return {
    oneOf: [{ type: 'boolean' }, obj(optsProps)],
  };
}

function str(extra: Partial<JsonSchema> = {}): JsonSchema {
  return { type: 'string', ...extra };
}

function num(extra: Partial<JsonSchema> = {}): JsonSchema {
  return { type: 'number', ...extra };
}

function bool(): JsonSchema {
  return { type: 'boolean' };
}

function arr(items: JsonSchema): JsonSchema {
  return { type: 'array', items };
}

function enumStr(values: string[]): JsonSchema {
  return { type: 'string', enum: values };
}

function singleKeyStep(key: string, valueSchema: JsonSchema, description?: string): JsonSchema {
  const properties: Record<string, JsonSchema> = { [key]: valueSchema };
  const s = obj(properties, [key]);
  if (description) s.description = description;
  return s;
}

function buildChecksSchema(): JsonSchema {
  const properties: Record<string, JsonSchema> = {
    a11y: boolOrOpts(),
    perf: boolOrOpts(),
    visual: boolOrOpts(),
    explore: boolOrOpts({ maxClicks: num() }),
    seo: boolOrOpts(),
    links: boolOrOpts({ maxLinks: num(), sameOriginOnly: bool() }),
    pwa: boolOrOpts(),
    security: boolOrOpts(),
    retire: boolOrOpts(),
    deadClicks: boolOrOpts({ maxElements: num(), waitAfterClickMs: num() }),
    touchTargets: boolOrOpts({ minSize: num(), onlyViewport: bool() }),
    keyboard: boolOrOpts({ maxTabs: num(), requireFocusRing: bool() }),
    longTasks: boolOrOpts({ durationMs: num() }),
    clsTimeline: boolOrOpts({ durationMs: num() }),
    forms: boolOrOpts(),
    structuredData: boolOrOpts(),
    passiveSecurity: boolOrOpts(),
    consoleErrors: boolOrOpts(),
    sitemap: boolOrOpts({ checkUrls: bool(), sampleSize: num() }),
    redirects: boolOrOpts({ maxHops: num() }),
    exposedPaths: boolOrOpts({ concurrency: num(), extraPaths: arr(str()) }),
    tls: boolOrOpts(),
    crawl: boolOrOpts({ maxDepth: num(), maxPages: num(), sameOriginOnly: bool() }),
    contentQuality: boolOrOpts({ minWords: num(), dupThreshold: num() }),
    resourceHints: boolOrOpts(),
    mixedContent: boolOrOpts(),
    compression: boolOrOpts(),
    cacheHeaders: boolOrOpts(),
    cookieBanner: boolOrOpts(),
    thirdParty: boolOrOpts(),
    bundleSize: boolOrOpts(),
    openGraph: boolOrOpts(),
    robotsAudit: boolOrOpts(),
    imageAudit: boolOrOpts(),
    webfonts: boolOrOpts(),
    motionPrefs: boolOrOpts(),
    serviceWorker: boolOrOpts(),
    rum: boolOrOpts({ durationMs: num() }),
    amp: boolOrOpts(),
    jsCoverage: boolOrOpts({ threshold: num() }),
    cssCoverage: boolOrOpts({ threshold: num() }),
    domSize: boolOrOpts({ maxNodes: num(), maxDepth: num(), maxChildren: num() }),
    ariaAudit: boolOrOpts(),
    headings: boolOrOpts(),
    langAudit: boolOrOpts(),
    protocols: boolOrOpts(),
    fontLoading: boolOrOpts(),
    prerenderAudit: boolOrOpts(),
    headlessDetect: boolOrOpts(),
    animations: boolOrOpts(),
    eventListeners: boolOrOpts(),
    darkMode: boolOrOpts({ screenshotDir: str(), sampleSelectors: arr(str()) }),
    tables: boolOrOpts(),
    svgs: boolOrOpts(),
    media: boolOrOpts(),
    readingLevel: boolOrOpts({ maxGrade: num(), mainSelector: str() }),
    deadImages: boolOrOpts(),
    pagination: boolOrOpts({ scrollProbes: num() }),
    print: boolOrOpts({ screenshotPath: str() }),
    canonical: boolOrOpts({ followChain: bool() }),
  };
  return obj(properties);
}

function buildStepVariants(): JsonSchema[] {
  const selText = obj({ selector: str(), text: str() }, ['selector', 'text']);
  const httpMethod = enumStr(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
  return [
    singleKeyStep('goto', str(), 'Navigate to a URL or path.'),
    singleKeyStep('click', str(), 'Click a selector.'),
    singleKeyStep('type', selText, 'Type text into a field.'),
    singleKeyStep('fill', selText, 'Fill a field (clears first).'),
    singleKeyStep('waitFor', str(), 'Wait for a selector.'),
    singleKeyStep('screenshot', str(), 'Capture a screenshot with the given name.'),
    singleKeyStep('ai', str(), 'Natural-language AI-driven step.'),
    singleKeyStep('drag', obj({ from: str(), to: str() }, ['from', 'to'])),
    singleKeyStep(
      'upload',
      obj({ selector: str(), files: { oneOf: [str(), arr(str())] } }, ['selector', 'files']),
    ),
    singleKeyStep('dialog', {
      oneOf: [
        enumStr(['accept', 'dismiss']),
        obj({ accept: bool(), text: str() }),
      ],
    }),
    singleKeyStep('scroll', obj({ selector: str(), x: num(), y: num() })),
    singleKeyStep(
      'select',
      obj({ selector: str(), value: { oneOf: [str(), arr(str())] } }, ['selector', 'value']),
    ),
    singleKeyStep('key', str(), 'Press a keyboard key.'),
    singleKeyStep('eval', str(), 'Evaluate a JS expression in the page.'),
    singleKeyStep('waitForResponse', {
      oneOf: [str(), obj({ url: str(), status: num() }, ['url'])],
    }),
    singleKeyStep('waitForRequest', str()),
    singleKeyStep('hover', str()),
    singleKeyStep('check', str()),
    singleKeyStep('uncheck', str()),
    singleKeyStep('focus', str()),
    singleKeyStep('blur', str()),
    singleKeyStep('reload', { const: true }),
    singleKeyStep('back', { const: true }),
    singleKeyStep('forward', { const: true }),
    singleKeyStep('newTab', str()),
    singleKeyStep('switchTab', { oneOf: [num(), str()] }),
    singleKeyStep('closeTab', { const: true }),
    singleKeyStep(
      'iframe',
      obj(
        {
          selector: str(),
          steps: arr({ $ref: '#/definitions/Step' }),
        },
        ['selector', 'steps'],
      ),
    ),
    singleKeyStep('sleep', num(), 'Sleep for N ms.'),
    singleKeyStep(
      'waitForDownload',
      obj({ trigger: str(), saveAs: str() }, ['trigger', 'saveAs']),
    ),
    singleKeyStep(
      'waitForPopup',
      obj({ trigger: str(), switchTo: bool() }, ['trigger']),
    ),
    singleKeyStep(
      'cookie',
      obj(
        {
          name: str(),
          value: str(),
          domain: str(),
          path: str(),
          expires: num(),
          httpOnly: bool(),
          secure: bool(),
          sameSite: enumStr(['Strict', 'Lax', 'None']),
        },
        ['name', 'value'],
      ),
    ),
    singleKeyStep('clearCookies', { const: true }),
    // ApiStep variants (apiFlows uses these)
    singleKeyStep(
      'request',
      obj(
        {
          method: httpMethod,
          url: str(),
          headers: { type: 'object', additionalProperties: str() },
          body: {},
        },
        ['method', 'url'],
      ),
    ),
    singleKeyStep(
      'expect',
      obj({
        status: num(),
        statusIn: arr(num()),
        headerIncludes: obj({ name: str(), value: str() }, ['name', 'value']),
        bodyIncludes: str(),
        jsonPath: obj({ path: str(), equals: {}, exists: bool() }, ['path']),
      }),
    ),
  ];
}

function buildViewport(): JsonSchema {
  return obj({ name: str(), width: num(), height: num() }, ['name', 'width', 'height']);
}

function buildFlow(): JsonSchema {
  return obj(
    { name: str(), steps: arr({ $ref: '#/definitions/Step' }) },
    ['name', 'steps'],
  );
}

function buildApiFlow(): JsonSchema {
  return obj(
    { name: str(), steps: arr({ $ref: '#/definitions/ApiStep' }) },
    ['name', 'steps'],
  );
}

function buildBudget(): JsonSchema {
  return obj({
    perf: obj({
      performance: num(),
      accessibility: num(),
      bestPractices: num(),
      seo: num(),
    }),
    metrics: obj({ lcpMs: num(), fcpMs: num(), cls: num(), tbtMs: num(), siMs: num() }),
    a11y: obj({ maxCritical: num(), maxSerious: num(), maxTotal: num() }),
    visual: obj({ maxDiffRatio: num() }),
    flows: obj({ maxFailures: num() }),
  });
}

function buildMock(): JsonSchema {
  const httpMethod = enumStr(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
  return obj(
    {
      pattern: str(),
      method: httpMethod,
      action: {
        oneOf: [
          { const: 'abort' },
          obj({
            status: num(),
            headers: { type: 'object', additionalProperties: str() },
            body: str(),
            contentType: str(),
          }),
        ],
      },
    },
    ['pattern', 'action'],
  );
}

function buildNotify(): JsonSchema {
  return obj({
    slackWebhook: str({ format: 'uri' }),
    discordWebhook: str({ format: 'uri' }),
    genericWebhook: str({ format: 'uri' }),
    onlyOnFail: bool(),
  });
}

export function generateConfigSchema(): JsonSchema {
  const stepSchema: JsonSchema = { oneOf: buildStepVariants() };

  const definitions: Record<string, JsonSchema> = {
    Step: stepSchema,
    ApiStep: stepSchema,
    Flow: buildFlow(),
    ApiFlow: buildApiFlow(),
    Viewport: buildViewport(),
    Checks: buildChecksSchema(),
    Budget: buildBudget(),
    RouteMock: buildMock(),
    Notify: buildNotify(),
  };

  const properties: Record<string, JsonSchema> = {
    url: str({ format: 'uri', description: 'Target URL to inspect.' }),
    flows: arr({ $ref: '#/definitions/Flow' }),
    viewports: arr({ $ref: '#/definitions/Viewport' }),
    checks: { $ref: '#/definitions/Checks' },
    output: obj({
      dir: str(),
      baselineDir: str(),
      reportFormat: enumStr(['html', 'json', 'both']),
    }),
    ai: obj({
      enabled: bool(),
      model: str(),
      cachePath: str(),
      cacheTtlMs: num({ minimum: 0 }),
      fallback: obj({
        ollama: obj({
          enabled: bool(),
          url: str({ format: 'uri' }),
          model: str(),
          timeoutMs: num({ minimum: 0 }),
        }),
      }),
    }),
    headed: bool(),
    parallel: bool(),
    storageState: str(),
    reporters: arr(enumStr(['html', 'json', 'junit', 'sarif', 'allure', 'tap'])),
    browser: enumStr(['chromium', 'firefox', 'webkit']),
    device: str(),
    locale: str(),
    timezoneId: str(),
    geolocation: obj({ latitude: num(), longitude: num() }, ['latitude', 'longitude']),
    network: enumStr(['slow-3g', 'fast-3g', '4g', 'wifi']),
    trace: bool(),
    video: bool(),
    har: bool(),
    budget: { $ref: '#/definitions/Budget' },
    notify: { $ref: '#/definitions/Notify' },
    mocks: arr({ $ref: '#/definitions/RouteMock' }),
    debug: bool(),
    slowMo: num({ minimum: 0 }),
    apiFlows: arr({ $ref: '#/definitions/ApiFlow' }),
  };

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://uxinspect.com/schemas/config.json',
    title: 'uxinspect config',
    type: 'object',
    required: ['url'],
    properties,
    additionalProperties: false,
    definitions,
  };
}

export async function writeSchemaFile(outPath: string): Promise<void> {
  const schema = generateConfigSchema();
  const json = JSON.stringify(schema, null, 2);
  await writeFile(outPath, json + '\n', 'utf8');
}
