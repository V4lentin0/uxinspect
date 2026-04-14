const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    types { name }
    queryType { fields { name } }
    mutationType { fields { name } }
    subscriptionType { fields { name } }
  }
}`;

export interface GqlFlow {
  name: string;
  endpoint: string;
  headers?: Record<string, string>;
  timeout?: number;
  steps: GqlStep[];
}

export type GqlStep =
  | { query: { query: string; variables?: Record<string, unknown>; operationName?: string } }
  | { mutate: { query: string; variables?: Record<string, unknown>; operationName?: string } }
  | { introspect: true }
  | {
      expect: {
        noErrors?: boolean;
        errorIncludes?: string;
        dataPath?: { path: string; equals?: unknown; exists?: boolean };
        typeName?: string;
      };
    };

export interface GqlStepResult {
  step: GqlStep;
  passed: boolean;
  durationMs: number;
  httpStatus?: number;
  graphqlErrors?: { message: string; path?: string[] }[];
  data?: unknown;
  error?: string;
}

export interface GqlFlowResult {
  name: string;
  endpoint: string;
  passed: boolean;
  steps: GqlStepResult[];
  introspection?: {
    types: string[];
    queries: string[];
    mutations: string[];
    subscriptions: string[];
  };
  error?: string;
}

interface GqlResponse {
  data?: unknown;
  errors?: { message: string; path?: string[] }[];
}

export async function runGraphQLFlow(flow: GqlFlow): Promise<GqlFlowResult> {
  const timeout = flow.timeout ?? 10000;
  const stepResults: GqlStepResult[] = [];
  let passed = true;
  let error: string | undefined;
  let introspection: GqlFlowResult['introspection'];

  let lastHttpStatus: number | undefined;
  let lastData: unknown;
  let lastErrors: { message: string; path?: string[] }[] | undefined;

  for (const step of flow.steps) {
    const start = Date.now();
    try {
      if ('query' in step) {
        const { body, status } = await post(flow.endpoint, flow.headers, timeout, {
          query: step.query.query,
          variables: step.query.variables,
          operationName: step.query.operationName,
        });
        lastHttpStatus = status;
        lastData = body.data;
        lastErrors = body.errors;
        stepResults.push({
          step,
          passed: true,
          durationMs: Date.now() - start,
          httpStatus: status,
          graphqlErrors: body.errors,
          data: body.data,
        });
      } else if ('mutate' in step) {
        const { body, status } = await post(flow.endpoint, flow.headers, timeout, {
          query: step.mutate.query,
          variables: step.mutate.variables,
          operationName: step.mutate.operationName,
        });
        lastHttpStatus = status;
        lastData = body.data;
        lastErrors = body.errors;
        stepResults.push({
          step,
          passed: true,
          durationMs: Date.now() - start,
          httpStatus: status,
          graphqlErrors: body.errors,
          data: body.data,
        });
      } else if ('introspect' in step) {
        const { body, status } = await post(flow.endpoint, flow.headers, timeout, {
          query: INTROSPECTION_QUERY,
        });
        lastHttpStatus = status;
        lastData = body.data;
        lastErrors = body.errors;
        const schema = (body.data as any)?.__schema;
        if (schema) {
          introspection = {
            types: (schema.types ?? []).map((t: any) => t?.name).filter(Boolean),
            queries: (schema.queryType?.fields ?? []).map((f: any) => f?.name).filter(Boolean),
            mutations: (schema.mutationType?.fields ?? []).map((f: any) => f?.name).filter(Boolean),
            subscriptions: (schema.subscriptionType?.fields ?? []).map((f: any) => f?.name).filter(Boolean),
          };
        }
        stepResults.push({
          step,
          passed: true,
          durationMs: Date.now() - start,
          httpStatus: status,
          graphqlErrors: body.errors,
          data: body.data,
        });
      } else if ('expect' in step) {
        const e = step.expect;
        if (lastHttpStatus === undefined) throw new Error('no prior response to assert on');
        if (e.noErrors === true && lastErrors && lastErrors.length > 0) {
          throw new Error(`expected no errors, got ${lastErrors.length}: ${lastErrors[0].message}`);
        }
        if (e.errorIncludes) {
          const combined = (lastErrors ?? []).map((x) => x.message).join('\n');
          if (!combined.includes(e.errorIncludes)) {
            throw new Error(`no error includes ${e.errorIncludes}`);
          }
        }
        if (e.dataPath) {
          const val = getPath(lastData, e.dataPath.path);
          if (e.dataPath.exists === true && val === undefined) {
            throw new Error(`dataPath ${e.dataPath.path} missing`);
          }
          if (e.dataPath.exists === false && val !== undefined) {
            throw new Error(`dataPath ${e.dataPath.path} should be missing`);
          }
          if (e.dataPath.equals !== undefined && JSON.stringify(val) !== JSON.stringify(e.dataPath.equals)) {
            throw new Error(`dataPath ${e.dataPath.path}: ${JSON.stringify(val)} !== ${JSON.stringify(e.dataPath.equals)}`);
          }
        }
        if (e.typeName) {
          if (!introspection) throw new Error('no introspection result; run introspect step first');
          if (!introspection.types.includes(e.typeName)) {
            throw new Error(`type ${e.typeName} not in schema`);
          }
        }
        stepResults.push({
          step,
          passed: true,
          durationMs: Date.now() - start,
          httpStatus: lastHttpStatus,
          graphqlErrors: lastErrors,
          data: lastData,
        });
      }
    } catch (err: any) {
      passed = false;
      error = err?.message ?? String(err);
      stepResults.push({
        step,
        passed: false,
        durationMs: Date.now() - start,
        httpStatus: lastHttpStatus,
        graphqlErrors: lastErrors,
        data: lastData,
        error,
      });
      break;
    }
  }

  return {
    name: flow.name,
    endpoint: flow.endpoint,
    passed,
    steps: stepResults,
    introspection,
    error,
  };
}

async function post(
  endpoint: string,
  headers: Record<string, string> | undefined,
  timeout: number,
  body: { query: string; variables?: Record<string, unknown>; operationName?: string },
): Promise<{ status: number; body: GqlResponse }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    let parsed: GqlResponse = {};
    if (text) {
      try {
        parsed = JSON.parse(text) as GqlResponse;
      } catch {
        parsed = { errors: [{ message: `invalid JSON response: ${text.slice(0, 200)}` }] };
      }
    }
    return { status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

function getPath(obj: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}
