// Feature: bedrock-agentcore-web-app, Property 7: OGX Responses API call always includes MCP tool with correct server_url and authorization
// Feature: bedrock-agentcore-web-app, Property 8: Session ID round-trip
// Feature: bedrock-agentcore-web-app, Property 9: Successful response structure invariant
// Feature: bedrock-agentcore-web-app, Property 10: Gateway or OGX HTTP errors are mapped to HTTP 502
// Feature: bedrock-agentcore-web-app, Property 11: Query length validation rejects oversized inputs
// Feature: bedrock-agentcore-web-app, Property 12: Non-JSON Content-Type is rejected with HTTP 415
// Feature: bedrock-agentcore-web-app, Property 6: Invalid token causes HTTP 503 on every invoke-agent request

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import { buildOgxPayload, createAgentRouter, extractContent } from '../agentRouter.js';
import type { AppConfig, OgxResponsesOutput } from '../types.js';
import type { TokenManager } from '../tokenManager.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    gatewayUrl: 'https://gateway.example.com',
    cognitoTokenUrl: 'https://cognito.example.com/token',
    cognitoClientId: 'test-client-id',
    cognitoClientSecret: 'test-client-secret',
    ollamaUrl: 'http://localhost:11434/v1',
    ollamaModel: 'ollama/llama3.2',
    ogxBaseUrl: 'http://localhost:8321',
    port: 5000,
  };
  return { ...base, ...overrides };
}

function makeTokenManager(token: string | null): TokenManager {
  return {
    getToken: () => token,
    getTokenInfo: () => ({ expiresAt: new Date().toISOString(), remainingSeconds: 3600, scopes: [] }),
    initialize: async () => {},
    destroy: () => {},
  } as unknown as TokenManager;
}

/**
 * Builds a minimal Express app with the agent router mounted at /api/invoke-agent.
 */
function buildApp(
  config: AppConfig,
  tokenManager: TokenManager,
  fetchFn?: typeof fetch
): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/invoke-agent', createAgentRouter(config, tokenManager, fetchFn));
  return app;
}

/**
 * Creates a mock fetch that returns a successful OGX response with the given output.
 */
function mockSuccessFetch(output: OgxResponsesOutput['output']): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ output }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * Creates a mock fetch that returns an HTTP error response.
 */
function mockErrorFetch(status: number, statusText: string): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ error: statusText }), {
      status,
      statusText,
      headers: { 'Content-Type': 'application/json' },
    });
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const textBlockArb = fc.record({
  type: fc.constant('message' as const),
  role: fc.constant('assistant' as const),
  content: fc.array(
    fc.record({
      type: fc.constant('output_text' as const),
      text: fc.string({ minLength: 1 }),
    }),
    { minLength: 1, maxLength: 5 }
  ),
});

const imageBlockArb = fc.record({
  type: fc.constant('message' as const),
  role: fc.constant('assistant' as const),
  content: fc.array(
    fc.record({
      type: fc.constant('image_url' as const),
      image_url: fc.record({
        url: fc.webUrl(),
        detail: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
      }),
    }),
    { minLength: 1, maxLength: 3 }
  ),
});

// ---------------------------------------------------------------------------
// Property 7: OGX call includes correct MCP tool
// Validates: Requirements 3.1, 3.2
// ---------------------------------------------------------------------------

describe('Property 7: OGX Responses API call always includes MCP tool with correct server_url and authorization', () => {
  it('buildOgxPayload produces tools[0] with type=mcp, correct server_url and authorization', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 10000 }),
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (query, bearerToken, gatewayUrl) => {
          const config = makeConfig({ gatewayUrl });
          const payload = buildOgxPayload(query, bearerToken, config, "aws");

          if (!payload.tools || payload.tools.length === 0) {
            throw new Error('Expected tools array to be non-empty');
          }
          const tool = payload.tools[0];
          if (tool.type !== 'mcp') {
            throw new Error(`Expected tools[0].type === "mcp" but got "${tool.type}"`);
          }
          if (tool.server_url !== gatewayUrl) {
            throw new Error(`Expected tools[0].server_url === "${gatewayUrl}" but got "${tool.server_url}"`);
          }
          if (tool.authorization !== bearerToken) {
            throw new Error(`Expected tools[0].authorization === "${bearerToken}" but got "${tool.authorization}"`);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8: Session ID round-trip
// Validates: Requirements 3.3, 3.4
// ---------------------------------------------------------------------------

describe('Property 8: Session ID round-trip', () => {
  it('echoes provided sessionId back in the response', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.string({ minLength: 1, maxLength: 500 }),
        async (sessionId, query) => {
          const config = makeConfig();
          const tokenManager = makeTokenManager('test-bearer-token');
          const fetchFn = mockSuccessFetch([]);
          const app = buildApp(config, tokenManager, fetchFn);

          const res = await request(app)
            .post('/api/invoke-agent')
            .set('Content-Type', 'application/json')
            .send({ query, sessionId });

          if (res.status !== 200) {
            throw new Error(`Expected 200 but got ${res.status}: ${JSON.stringify(res.body)}`);
          }
          if (res.body.sessionId !== sessionId) {
            throw new Error(`Expected sessionId "${sessionId}" but got "${res.body.sessionId as string}"`);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('generates a valid UUID v4 when sessionId is omitted', async () => {
    const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 500 }),
        async (query) => {
          const config = makeConfig();
          const tokenManager = makeTokenManager('test-bearer-token');
          const fetchFn = mockSuccessFetch([]);
          const app = buildApp(config, tokenManager, fetchFn);

          const res = await request(app)
            .post('/api/invoke-agent')
            .set('Content-Type', 'application/json')
            .send({ query });

          if (res.status !== 200) {
            throw new Error(`Expected 200 but got ${res.status}: ${JSON.stringify(res.body)}`);
          }
          const returnedId = res.body.sessionId as string;
          if (!returnedId || returnedId.length === 0) {
            throw new Error('Expected non-empty sessionId in response');
          }
          if (!UUID_V4_RE.test(returnedId)) {
            throw new Error(`Expected valid UUID v4 but got "${returnedId}"`);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9: Successful response structure invariant
// Validates: Requirements 3.5, 3.6
// ---------------------------------------------------------------------------

describe('Property 9: Successful response structure invariant', () => {
  it('extractContent returns correct structure for any combination of text and image blocks', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(textBlockArb, imageBlockArb), { minLength: 0, maxLength: 10 }),
        (outputItems) => {
          // Cast to the expected type
          const output = outputItems as OgxResponsesOutput['output'];
          const content = extractContent(output);

          if (!content || typeof content !== 'object') {
            throw new Error('Expected content to be a non-null object');
          }
          if (!Array.isArray(content.text)) {
            throw new Error('Expected content.text to be an array');
          }
          if (!Array.isArray(content.images)) {
            throw new Error('Expected content.images to be an array');
          }
          for (const img of content.images) {
            if (typeof img.alt !== 'string' || img.alt.length === 0) {
              throw new Error(`Expected image.alt to be a non-empty string but got "${img.alt}"`);
            }
            if (typeof img.url !== 'string' || img.url.length === 0) {
              throw new Error(`Expected image.url to be a non-empty string but got "${img.url}"`);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('POST /api/invoke-agent returns success=true, non-null content, non-empty sessionId', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.oneof(textBlockArb, imageBlockArb), { minLength: 0, maxLength: 5 }),
        fc.string({ minLength: 1, maxLength: 500 }),
        async (outputItems, query) => {
          const config = makeConfig();
          const tokenManager = makeTokenManager('test-bearer-token');
          const output = outputItems as OgxResponsesOutput['output'];
          const fetchFn = mockSuccessFetch(output);
          const app = buildApp(config, tokenManager, fetchFn);

          const res = await request(app)
            .post('/api/invoke-agent')
            .set('Content-Type', 'application/json')
            .send({ query });

          if (res.status !== 200) {
            throw new Error(`Expected 200 but got ${res.status}`);
          }
          if (res.body.success !== true) {
            throw new Error('Expected success === true');
          }
          if (!res.body.content || typeof res.body.content !== 'object') {
            throw new Error('Expected non-null content object');
          }
          if (!res.body.sessionId || res.body.sessionId.length === 0) {
            throw new Error('Expected non-empty sessionId');
          }
          for (const img of (res.body.content.images ?? []) as Array<{ alt: string; url: string }>) {
            if (!img.alt || img.alt.length === 0) {
              throw new Error('Expected image.alt to be non-empty');
            }
            if (!img.url || img.url.length === 0) {
              throw new Error('Expected image.url to be non-empty');
            }
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 10: Gateway error → HTTP 502
// Validates: Requirements 3.7
// ---------------------------------------------------------------------------

describe('Property 10: Gateway or OGX HTTP errors are mapped to HTTP 502', () => {
  it('returns 502 with success=false and error starting with "Failed to invoke agent:" for any 4xx/5xx', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 400, max: 599 }),
        fc.string({ minLength: 1, maxLength: 500 }),
        async (statusCode, query) => {
          const config = makeConfig();
          const tokenManager = makeTokenManager('test-bearer-token');
          const statusText = `Error ${statusCode}`;
          const fetchFn = mockErrorFetch(statusCode, statusText);
          const app = buildApp(config, tokenManager, fetchFn);

          const res = await request(app)
            .post('/api/invoke-agent')
            .set('Content-Type', 'application/json')
            .send({ query });

          if (res.status !== 502) {
            throw new Error(`Expected 502 but got ${res.status}`);
          }
          if (res.body.success !== false) {
            throw new Error('Expected success === false');
          }
          if (typeof res.body.error !== 'string' || !res.body.error.startsWith('Failed to invoke agent [')) {
            throw new Error(`Expected error to start with "Failed to invoke agent [" but got "${res.body.error as string}"`);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 11: Query length validation rejects oversized inputs
// Validates: Requirements 7.5
// ---------------------------------------------------------------------------

describe('Property 11: Query length validation rejects oversized inputs', () => {
  it('returns 400 for queries > 10000 chars and never calls OGX', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 10001, maxLength: 20000 }),
        async (longQuery) => {
          const config = makeConfig();
          const tokenManager = makeTokenManager('test-bearer-token');
          let ogxCalled = false;
          const fetchFn: typeof fetch = async () => {
            ogxCalled = true;
            return new Response('{}', { status: 200 });
          };
          const app = buildApp(config, tokenManager, fetchFn);

          const res = await request(app)
            .post('/api/invoke-agent')
            .set('Content-Type', 'application/json')
            .send({ query: longQuery });

          if (res.status !== 400) {
            throw new Error(`Expected 400 but got ${res.status}`);
          }
          if (res.body.success !== false) {
            throw new Error('Expected success === false');
          }
          if (res.body.error !== 'Failed to process request: query exceeds maximum length') {
            throw new Error(`Unexpected error message: "${res.body.error as string}"`);
          }
          if (ogxCalled) {
            throw new Error('OGX fetch should not have been called for oversized query');
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 12: Non-JSON Content-Type → HTTP 415
// Validates: Requirements 7.4
// ---------------------------------------------------------------------------

describe('Property 12: Non-JSON Content-Type is rejected with HTTP 415', () => {
  it('returns 415 for non-application/json content types and never calls OGX', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((s) => !s.includes('application/json')),
        async (contentType) => {
          const config = makeConfig();
          const tokenManager = makeTokenManager('test-bearer-token');
          let ogxCalled = false;
          const fetchFn: typeof fetch = async () => {
            ogxCalled = true;
            return new Response('{}', { status: 200 });
          };
          const app = buildApp(config, tokenManager, fetchFn);

          const res = await request(app)
            .post('/api/invoke-agent')
            .set('Content-Type', contentType || 'text/plain')
            .send('some body');

          if (res.status !== 415) {
            throw new Error(`Expected 415 but got ${res.status} (Content-Type: "${contentType}")`);
          }
          if (ogxCalled) {
            throw new Error('OGX fetch should not have been called for non-JSON content type');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: Invalid token → HTTP 503
// Validates: Requirements 2.5
// ---------------------------------------------------------------------------

describe('Property 6: Invalid token causes HTTP 503 on every invoke-agent request', () => {
  it('returns 503 with correct error when tokenManager.getToken() returns null', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 500 }),
        async (query) => {
          const config = makeConfig();
          const tokenManager = makeTokenManager(null);
          let ogxCalled = false;
          const fetchFn: typeof fetch = async () => {
            ogxCalled = true;
            return new Response('{}', { status: 200 });
          };
          const app = buildApp(config, tokenManager, fetchFn);

          const res = await request(app)
            .post('/api/invoke-agent')
            .set('Content-Type', 'application/json')
            .send({ query });

          if (res.status !== 503) {
            throw new Error(`Expected 503 but got ${res.status}`);
          }
          if (res.body.success !== false) {
            throw new Error('Expected success === false');
          }
          if (res.body.error !== 'Failed to process request: OAuth2 token unavailable') {
            throw new Error(`Unexpected error message: "${res.body.error as string}"`);
          }
          if (ogxCalled) {
            throw new Error('OGX fetch should not have been called when token is unavailable');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
