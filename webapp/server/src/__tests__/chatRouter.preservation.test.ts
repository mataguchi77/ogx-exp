/**
 * Preservation Property Tests for chatRouter
 *
 * These tests encode the CURRENT behavior of the unfixed chatRouter to ensure
 * no regressions are introduced when the fix is applied.
 *
 * Feature: frontend-rag-routing, Property 2: Preservation
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import { createChatRouter } from '../chatRouter.js';
import type { AppConfig } from '../types.js';
import type { TokenManager } from '../tokenManager.js';
import type { RagConfig } from '../ragConfig.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function mockConfig(): AppConfig {
  return {
    gatewayUrl: 'https://gateway.example.com/invoke',
    cognitoTokenUrl: 'https://cognito.example.com/oauth2/token',
    cognitoClientId: 'test-client-id',
    cognitoClientSecret: 'test-client-secret',
    ollamaUrl: 'http://localhost:11434/v1',
    ollamaModel: 'ollama/llama3.1:8b',
    ogxBaseUrl: 'http://localhost:8321',
    port: 5000,
  };
}

function mockTokenManager(): TokenManager {
  return {
    getToken: () => 'mock-token',
    getTokenInfo: () => ({
      expiresAt: new Date().toISOString(),
      remainingSeconds: 3600,
      scopes: [],
    }),
    initialize: async () => {},
    destroy: () => {},
  } as unknown as TokenManager;
}

function mockRagConfig(): RagConfig {
  return {
    ragSource: 'ollama',
    embeddingModel: 'ollama/mxbai-embed-large',
    embeddingDimension: 1024,
    vectorStoreName: 'rag-documents',
    vectorStoreId: null,
  };
}

function buildApp(fetchFn?: typeof fetch): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/chat/stream', createChatRouter(mockConfig(), mockTokenManager(), mockRagConfig(), fetchFn));
  return app;
}

function mockSseFetch(): typeof fetch {
  return async () => {
    const encoder = new TextEncoder();
    const body = 'data: [DONE]\n\n';
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });
    return new Response(readable, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
}

function mockErrorFetch(status: number, body: string): typeof fetch {
  return async () =>
    new Response(body, {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
}

function mockNetworkErrorFetch(): typeof fetch {
  return async (): Promise<Response> => {
    throw new TypeError('Failed to fetch');
  };
}

// ---------------------------------------------------------------------------
// Property 2a: Validation — invalid message arrays return 400
// **Validates: Requirements 3.1**
// ---------------------------------------------------------------------------

describe('Preservation Property 2a: Invalid message arrays return 400 with correct error structure', () => {
  it('empty messages array returns 400 with "messages array is required and must not be empty"', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate empty arrays or absent/null/non-array messages
        fc.oneof(
          fc.constant([] as Array<{ role: string; content: string }>),
          fc.constant(null),
          fc.constant(undefined as unknown as null),
        ),
        async (messages) => {
          const app = buildApp(mockSseFetch());
          const body = messages === undefined ? {} : { messages };

          const res = await request(app)
            .post('/api/chat/stream')
            .set('Content-Type', 'application/json')
            .send(body);

          expect(res.status).toBe(400);
          expect(res.body.error).toBe(
            'Failed to process request: messages array is required and must not be empty',
          );
        },
      ),
      { numRuns: 50 },
    );
  });

  it('messages array with >100 items returns 400 with "messages array must not exceed 100 items"', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 101, max: 200 }),
        async (count) => {
          const messages = Array.from({ length: count }, (_, i) => ({
            role: 'user',
            content: `msg ${i}`,
          }));

          const app = buildApp(mockSseFetch());
          const res = await request(app)
            .post('/api/chat/stream')
            .set('Content-Type', 'application/json')
            .send({ messages });

          expect(res.status).toBe(400);
          expect(res.body.error).toBe(
            'Failed to process request: messages array must not exceed 100 items',
          );
        },
      ),
      { numRuns: 50 },
    );
  });

  it('non-array messages (strings, numbers, objects) return 400', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.string(),
          fc.integer(),
          fc.boolean(),
          fc.record({ key: fc.string() }),
        ),
        async (messages) => {
          const app = buildApp(mockSseFetch());
          const res = await request(app)
            .post('/api/chat/stream')
            .set('Content-Type', 'application/json')
            .send({ messages });

          expect(res.status).toBe(400);
          expect(res.body.error).toBe(
            'Failed to process request: messages array is required and must not be empty',
          );
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2b: Upstream error responses preserve HTTP status codes
// **Validates: Requirements 3.2, 3.4**
// ---------------------------------------------------------------------------

describe('Preservation Property 2b: Upstream error responses return correct HTTP status and error payloads', () => {
  it('upstream 429 returns 429 with "Too many requests: <body>" error', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 200 }),
        async (errorBody) => {
          const app = buildApp(mockErrorFetch(429, errorBody));
          const res = await request(app)
            .post('/api/chat/stream')
            .set('Content-Type', 'application/json')
            .send({ messages: [{ role: 'user', content: 'test' }] });

          expect(res.status).toBe(429);
          expect(res.body.error).toBe(`Too many requests: ${errorBody}`);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('upstream non-2xx (5xx) returns 502 with "Failed to proxy stream: upstream returned <status>"', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 500, max: 599 }),
        async (status) => {
          const app = buildApp(mockErrorFetch(status, '{"error":"server error"}'));
          const res = await request(app)
            .post('/api/chat/stream')
            .set('Content-Type', 'application/json')
            .send({ messages: [{ role: 'user', content: 'test' }] });

          expect(res.status).toBe(502);
          expect(res.body.error).toBe(`Failed to proxy stream: upstream returned ${status}`);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('upstream non-2xx (4xx except 429) returns 502 with "Failed to proxy stream: upstream returned <status>"', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 400, max: 499 }).filter((s) => s !== 429),
        async (status) => {
          const app = buildApp(mockErrorFetch(status, '{"error":"client error"}'));
          const res = await request(app)
            .post('/api/chat/stream')
            .set('Content-Type', 'application/json')
            .send({ messages: [{ role: 'user', content: 'test' }] });

          expect(res.status).toBe(502);
          expect(res.body.error).toBe(`Failed to proxy stream: upstream returned ${status}`);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('network error (TypeError from fetch) returns 502 with "OGX endpoint unreachable"', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate various valid message payloads
        fc.array(
          fc.record({
            role: fc.constantFrom('user', 'assistant', 'system'),
            content: fc.string({ minLength: 1, maxLength: 50 }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        async (messages) => {
          const app = buildApp(mockNetworkErrorFetch());
          const res = await request(app)
            .post('/api/chat/stream')
            .set('Content-Type', 'application/json')
            .send({ messages });

          expect(res.status).toBe(502);
          expect(res.body.error).toBe('Failed to proxy stream: OGX endpoint unreachable');
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2c: Client disconnect aborts upstream and ends gracefully
// **Validates: Requirements 3.3**
// ---------------------------------------------------------------------------

describe('Preservation Property 2c: Client disconnect aborts upstream request', () => {
  it('AbortSignal is wired to upstream fetch for any valid messages request', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            role: fc.constantFrom('user', 'assistant', 'system'),
            content: fc.string({ minLength: 1, maxLength: 50 }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        async (messages) => {
          let capturedSignal: AbortSignal | null = null;

          const fetchFn: typeof fetch = async (_input, init) => {
            capturedSignal = (init?.signal as AbortSignal) ?? null;
            const readable = new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
                controller.close();
              },
            });
            return new Response(readable, {
              status: 200,
              headers: { 'Content-Type': 'text/event-stream' },
            });
          };

          const app = buildApp(fetchFn);
          await request(app)
            .post('/api/chat/stream')
            .set('Content-Type', 'application/json')
            .send({ messages });

          // Verify an AbortSignal was passed to fetch
          expect(capturedSignal).not.toBeNull();
          expect(capturedSignal).toBeInstanceOf(AbortSignal);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('AbortError from fetch ends response gracefully (no error payload)', async () => {
    const app = buildApp(async (_input, init): Promise<Response> => {
      // Simulate an AbortError (what happens when the controller is aborted)
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    });

    const res = await request(app)
      .post('/api/chat/stream')
      .set('Content-Type', 'application/json')
      .send({ messages: [{ role: 'user', content: 'test' }] });

    // When an AbortError occurs, the response should end gracefully
    // (empty body, no error JSON)
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
});
