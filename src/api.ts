import { request as createRequest, type APIRequestContext, type APIResponse } from 'playwright';
import type { ApiFlow, ApiFlowResult, ApiStep } from './types.js';

export async function runApiFlows(flows: ApiFlow[]): Promise<ApiFlowResult[]> {
  const ctx = await createRequest.newContext();
  const results: ApiFlowResult[] = [];
  try {
    for (const flow of flows) {
      results.push(await runOne(ctx, flow));
    }
  } finally {
    await ctx.dispose().catch(() => {});
  }
  return results;
}

async function runOne(ctx: APIRequestContext, flow: ApiFlow): Promise<ApiFlowResult> {
  const stepResults: ApiFlowResult['steps'] = [];
  let lastResponse: APIResponse | null = null;
  let lastBody = '';
  let passed = true;
  let error: string | undefined;

  for (const step of flow.steps) {
    const start = Date.now();
    try {
      if ('request' in step) {
        const r = step.request;
        lastResponse = await ctx.fetch(r.url, {
          method: r.method,
          headers: r.headers,
          data: r.body as any,
        });
        lastBody = await lastResponse.text().catch(() => '');
        stepResults.push({ step, passed: true, durationMs: Date.now() - start, status: lastResponse.status() });
      } else if ('expect' in step) {
        const e = step.expect;
        if (!lastResponse) throw new Error('no prior response to assert on');
        if (e.status !== undefined && lastResponse.status() !== e.status) {
          throw new Error(`status ${lastResponse.status()} !== ${e.status}`);
        }
        if (e.statusIn && !e.statusIn.includes(lastResponse.status())) {
          throw new Error(`status ${lastResponse.status()} not in ${e.statusIn.join(',')}`);
        }
        if (e.headerIncludes) {
          const v = lastResponse.headers()[e.headerIncludes.name.toLowerCase()] ?? '';
          if (!v.includes(e.headerIncludes.value)) throw new Error(`header ${e.headerIncludes.name} missing ${e.headerIncludes.value}`);
        }
        if (e.bodyIncludes && !lastBody.includes(e.bodyIncludes)) {
          throw new Error(`body missing ${e.bodyIncludes}`);
        }
        if (e.jsonPath) {
          const obj = JSON.parse(lastBody || 'null');
          const val = getPath(obj, e.jsonPath.path);
          if (e.jsonPath.exists === true && val === undefined) throw new Error(`jsonPath ${e.jsonPath.path} missing`);
          if (e.jsonPath.exists === false && val !== undefined) throw new Error(`jsonPath ${e.jsonPath.path} should be missing`);
          if (e.jsonPath.equals !== undefined && JSON.stringify(val) !== JSON.stringify(e.jsonPath.equals)) {
            throw new Error(`jsonPath ${e.jsonPath.path}: ${JSON.stringify(val)} !== ${JSON.stringify(e.jsonPath.equals)}`);
          }
        }
        stepResults.push({ step, passed: true, durationMs: Date.now() - start, status: lastResponse.status() });
      }
    } catch (e: any) {
      passed = false;
      error = e?.message ?? String(e);
      stepResults.push({ step, passed: false, durationMs: Date.now() - start, status: lastResponse?.status(), error });
      break;
    }
  }

  return { name: flow.name, passed, steps: stepResults, error };
}

function getPath(obj: any, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}
