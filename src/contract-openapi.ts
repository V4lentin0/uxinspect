export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  $ref?: string;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  nullable?: boolean;
  format?: string;
}

export interface Parameter {
  name?: string;
  in?: string;
  required?: boolean;
  schema?: JsonSchema;
}

export interface PathItem {
  parameters?: Parameter[];
  responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }>;
  operationId?: string;
}

export interface OpenApiSpec {
  openapi: string;
  info?: { title?: string; version?: string };
  servers?: { url: string }[];
  paths: Record<string, Record<string, PathItem>>;
  components?: { schemas?: Record<string, JsonSchema> };
}

export interface EndpointResult {
  method: string;
  path: string;
  url: string;
  status?: number;
  expectedStatuses: string[];
  passed: boolean;
  validationErrors: string[];
  skipped?: boolean;
}

export interface OpenApiContractResult {
  specSource: string;
  baseUrl: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  endpoints: EndpointResult[];
  overallPassed: boolean;
}

export interface RunOpenApiContractOptions {
  specUrl?: string;
  specJson?: OpenApiSpec;
  baseUrl?: string;
  headers?: Record<string, string>;
  timeout?: number;
  includePaths?: string[];
  excludePaths?: string[];
  methods?: string[];
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace']);
const CONCURRENCY = 5;

export async function runOpenApiContract(opts: RunOpenApiContractOptions): Promise<OpenApiContractResult> {
  const timeout = opts.timeout ?? 15000;
  let spec: OpenApiSpec;
  let specSource: string;

  if (opts.specJson) {
    spec = opts.specJson;
    specSource = 'inline';
  } else if (opts.specUrl) {
    const res = await fetch(opts.specUrl, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) {
      throw new Error(`failed to fetch spec: ${res.status} ${res.statusText}`);
    }
    spec = (await res.json()) as OpenApiSpec;
    specSource = opts.specUrl;
  } else {
    throw new Error('either specUrl or specJson is required');
  }

  const baseUrl = opts.baseUrl ?? spec.servers?.[0]?.url ?? '';
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    throw new Error(`baseUrl must be absolute, got: ${JSON.stringify(baseUrl)}`);
  }

  const methods = (opts.methods ?? ['get']).map((m) => m.toLowerCase());
  const includePaths = opts.includePaths ?? [];
  const excludePaths = opts.excludePaths ?? [];

  type Job = { method: string; path: string };
  const jobs: Job[] = [];
  const earlyResults: EndpointResult[] = [];

  for (const [pathKey, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    if (includePaths.length > 0 && !includePaths.some((p) => pathKey.includes(p))) continue;
    if (excludePaths.length > 0 && excludePaths.some((p) => pathKey.includes(p))) continue;

    for (const [methodKey, op] of Object.entries(pathItem)) {
      const method = methodKey.toLowerCase();
      if (method === 'parameters') continue;
      if (!HTTP_METHODS.has(method)) continue;
      if (!methods.includes(method)) continue;

      const url = joinUrl(baseUrl, pathKey);
      const expectedStatuses = Object.keys(op?.responses ?? {});

      if (/\{[^}]+\}/.test(pathKey)) {
        earlyResults.push({
          method: method.toUpperCase(),
          path: pathKey,
          url,
          status: undefined,
          expectedStatuses,
          passed: true,
          validationErrors: [],
          skipped: true,
        });
        continue;
      }

      jobs.push({ method, path: pathKey });
    }
  }

  const endpoints: EndpointResult[] = [...earlyResults];
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((j) => runOne(spec, baseUrl, j.method, j.path, opts.headers, timeout)),
    );
    endpoints.push(...batchResults);
  }

  const total = endpoints.length;
  const skipped = endpoints.filter((e) => e.skipped).length;
  const passed = endpoints.filter((e) => e.passed && !e.skipped).length;
  const failed = endpoints.filter((e) => !e.passed).length;

  return {
    specSource,
    baseUrl,
    total,
    passed,
    failed,
    skipped,
    endpoints,
    overallPassed: failed === 0,
  };
}

async function runOne(
  spec: OpenApiSpec,
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string> | undefined,
  timeout: number,
): Promise<EndpointResult> {
  const url = joinUrl(baseUrl, path);
  const op = spec.paths[path]?.[method];
  const responses = op?.responses ?? {};
  const expectedStatuses = Object.keys(responses);
  const validationErrors: string[] = [];
  let status: number | undefined;

  try {
    const res = await fetch(url, {
      method: method.toUpperCase(),
      headers,
      signal: AbortSignal.timeout(timeout),
    });
    status = res.status;

    const statusKey = String(res.status);
    const matchedKey = responses[statusKey]
      ? statusKey
      : responses['default']
        ? 'default'
        : undefined;

    if (!matchedKey) {
      validationErrors.push(
        `status ${res.status}: not in spec (expected ${expectedStatuses.join(', ') || 'none'})`,
      );
    }

    const ctype = res.headers.get('content-type') ?? '';
    if (ctype.includes('json')) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch (err) {
        validationErrors.push(`body: invalid JSON (${(err as Error).message})`);
      }

      if (matchedKey) {
        const schema = responses[matchedKey]?.content?.['application/json']?.schema
          ?? firstJsonSchema(responses[matchedKey]?.content);
        if (schema) {
          const errs = validate(body, schema, 'body', spec);
          validationErrors.push(...errs);
        }
      }
    }
  } catch (err) {
    validationErrors.push(`request failed: ${(err as Error).message}`);
  }

  return {
    method: method.toUpperCase(),
    path,
    url,
    status,
    expectedStatuses,
    passed: validationErrors.length === 0,
    validationErrors,
  };
}

function firstJsonSchema(
  content: Record<string, { schema?: JsonSchema }> | undefined,
): JsonSchema | undefined {
  if (!content) return undefined;
  for (const [ct, media] of Object.entries(content)) {
    if (ct.includes('json') && media?.schema) return media.schema;
  }
  const first = Object.values(content)[0];
  return first?.schema;
}

function joinUrl(base: string, path: string): string {
  if (!base) return path;
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return b + p;
}

function resolveRef(ref: string, spec: OpenApiSpec): JsonSchema | undefined {
  if (!ref.startsWith('#/')) return undefined;
  const parts = ref.slice(2).split('/');
  let cur: unknown = spec;
  for (const part of parts) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur as JsonSchema | undefined;
}

function validate(
  value: unknown,
  schema: JsonSchema,
  path: string,
  spec: OpenApiSpec,
  seen: Set<string> = new Set(),
): string[] {
  if (!schema) return [];

  if (schema.$ref) {
    if (seen.has(schema.$ref)) return [];
    const resolved = resolveRef(schema.$ref, spec);
    if (!resolved) return [`${path}: could not resolve $ref ${schema.$ref}`];
    const nextSeen = new Set(seen);
    nextSeen.add(schema.$ref);
    return validate(value, resolved, path, spec, nextSeen);
  }

  if (value === null) {
    if (schema.nullable === true) return [];
  }

  if (schema.allOf && schema.allOf.length > 0) {
    const errs: string[] = [];
    for (const sub of schema.allOf) {
      errs.push(...validate(value, sub, path, spec, seen));
    }
    return errs;
  }

  if (schema.oneOf && schema.oneOf.length > 0) {
    const branchErrs: string[][] = [];
    for (const sub of schema.oneOf) {
      const e = validate(value, sub, path, spec, seen);
      if (e.length === 0) return [];
      branchErrs.push(e);
    }
    return [`${path}: did not match any oneOf branch (${branchErrs.length} tried)`];
  }

  if (schema.anyOf && schema.anyOf.length > 0) {
    const branchErrs: string[][] = [];
    for (const sub of schema.anyOf) {
      const e = validate(value, sub, path, spec, seen);
      if (e.length === 0) return [];
      branchErrs.push(e);
    }
    return [`${path}: did not match any anyOf branch (${branchErrs.length} tried)`];
  }

  if (schema.enum && schema.enum.length > 0) {
    const found = schema.enum.some((v) => {
      try {
        return JSON.stringify(v) === JSON.stringify(value);
      } catch {
        return v === value;
      }
    });
    if (!found) {
      return [`${path}: value ${JSON.stringify(value)} not in enum`];
    }
  }

  const errs: string[] = [];
  const t = schema.type;
  if (t === 'object') {
    if (value === null && schema.nullable === true) return errs;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errs.push(`${path}: expected object, got ${describe(value)}`);
      return errs;
    }
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj)) {
        errs.push(`${path}.${req}: required field missing`);
      }
    }
    if (schema.properties) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in obj) {
          errs.push(...validate(obj[k], sub, `${path}.${k}`, spec, seen));
        }
      }
    }
    return errs;
  }

  if (t === 'array') {
    if (value === null && schema.nullable === true) return errs;
    if (!Array.isArray(value)) {
      errs.push(`${path}: expected array, got ${describe(value)}`);
      return errs;
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        errs.push(...validate(value[i], schema.items, `${path}[${i}]`, spec, seen));
      }
    }
    return errs;
  }

  if (t === 'string') {
    if (value === null && schema.nullable === true) return errs;
    if (typeof value !== 'string') errs.push(`${path}: expected string, got ${describe(value)}`);
    return errs;
  }

  if (t === 'integer') {
    if (value === null && schema.nullable === true) return errs;
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      errs.push(`${path}: expected integer, got ${describe(value)}`);
    }
    return errs;
  }

  if (t === 'number') {
    if (value === null && schema.nullable === true) return errs;
    if (typeof value !== 'number') errs.push(`${path}: expected number, got ${describe(value)}`);
    return errs;
  }

  if (t === 'boolean') {
    if (value === null && schema.nullable === true) return errs;
    if (typeof value !== 'boolean') errs.push(`${path}: expected boolean, got ${describe(value)}`);
    return errs;
  }

  return errs;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
