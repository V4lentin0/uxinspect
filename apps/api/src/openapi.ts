/**
 * P6 #58 — OpenAPI 3.1 spec generator for uxinspect REST API.
 */

export function generateOpenApiSpec(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'uxinspect API', version: '1.0.0', description: 'REST API for uxinspect results, flows, audits, and anomalies.' },
    servers: [{ url: 'https://api.uxinspect.com' }],
    security: [{ BearerAuth: [] }],
    components: {
      securitySchemes: { BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: {
        Run: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, score: { type: 'number' }, duration_ms: { type: 'integer' }, created_at: { type: 'string' } } },
        Flow: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, last_status: { type: 'string' }, run_count: { type: 'integer' } } },
        Anomaly: { type: 'object', properties: { metric: { type: 'string' }, direction: { type: 'string' }, z_score: { type: 'number' }, run_id: { type: 'string' } } },
        Error: { type: 'object', properties: { ok: { type: 'boolean' }, error: { type: 'string' } } },
      },
    },
    paths: {
      '/v1/runs': { get: { summary: 'List runs', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }, { name: 'cursor', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
      '/v1/runs/{id}': { get: { summary: 'Get run', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } }, delete: { summary: 'Soft-delete run', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deleted' } } } },
      '/v1/flows': { get: { summary: 'List flows', responses: { '200': { description: 'OK' } } } },
      '/v1/flows/{id}/history': { get: { summary: 'Flow run history', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
      '/v1/audits/{runId}': { get: { summary: 'Audit details for run', parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
      '/v1/anomalies': { get: { summary: 'Recent anomalies', responses: { '200': { description: 'OK' } } } },
      '/v1/coverage': { get: { summary: 'Coverage per route', responses: { '200': { description: 'OK' } } } },
      '/v1/export/{runId}': { get: { summary: 'Full JSON export', parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
      '/v1/repos': { get: { summary: 'List repositories', responses: { '200': { description: 'OK' } } } },
      '/v1/repos/{id}': { get: { summary: 'Repository detail', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
      '/v1/openapi.json': { get: { summary: 'This spec', responses: { '200': { description: 'OpenAPI 3.1 JSON' } } } },
    },
  };
}
