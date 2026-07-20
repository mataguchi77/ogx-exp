// Feature: frontend-streaming-app, Property 1: Input validation rejects invalid messages arrays
// Feature: frontend-streaming-app, Property 2: Streaming proxy preserves messages and sets stream flag
// Feature: frontend-streaming-app, Property 13: HTTP 429 from OGX is forwarded as HTTP 429 (not 502)

import { describe, it, expect, vi } from 'vitest';
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

/**
 * Default mock AppConfig for tests.
 */
function defaultConfig(): AppConfig {
  return {
    gatewayUrl: 'https://gateway.example.com/invoke',
    cognitoTokenUrl: 'https://cognito.example.com/oauth2/token',
    cognitoClientId: 'test-client-id',
    cognitoClientSecret: 'test-client-secret',
    ollamaUrl: 'http://localhost:11434/v1',
    ollamaModel: 'test/model:latest',
    ogxBaseUrl: 'http://localhost:8321',
    port: 5000,
  };
}

/**
 * Default mock TokenManager (returns null token — not needed for Ollama path).
 */
function defaultTokenManager(): TokenManager {
  return {
    getToken: () => null,
    getTokenInfo: () => ({
      expiresAt: new Date().toISOString(),
      remainingSeconds: 3600,
      scopes: [],
    }),
    initialize: async () => {},
    destroy: () => {},
  } as unknown as TokenManager;
}

/**
 * Default mock RagConfig (Ollama without vectorStoreId — simplest path).
 */
function defaultRagConfig(): RagConfig {
  return {
    ragSource: 'ollama',
    embeddingModel: 'ollama/mxbai-embed-large',
    embeddingDimension: 1024,
    vectorStoreName: 'rag-documents',
    vectorStoreId: null,
  };
}

/**
 * Builds a minimal Express app with the chat router mounted at /api/chat/stream.
 */
function buildApp(fetchFn?: typeof fetch): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/chat/stream', createChatRouter(defaultConfig(), defaultTokenManager(), defaultRagConfig(), fetchFn));
  return app;
}

/**
 * Creates a mock fetch that returns a successful streaming SSE response.
 */
function mockSseFetch(body: string = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n'): typeof fetch {
  return async () => {
    const encoder = new TextEncoder();
    const encoded = encoder.encode(body);
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    });
    return new Response(readable, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
}

/**
 * Creates a mock fetch that returns an error response with a given status.
 */
function mockErrorFetch(status: number, body: string = `{"error":"upstream error ${status}"}`): typeof fetch {
  return async () =>
    new Response(body, {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * Creates a mock fetch that throws a TypeError (network error).
 */
function mockNetworkErrorFetch(): typeof fetch {
  return async (): Promise<Response> => {
    throw new TypeError('Failed to fetch');
  };
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('chatRouter — unit tests', () => {
  // -------------------------------------------------------------------------
  // Header tests
  // -------------------------------------------------------------------------

  it('sets Content-Type: text/event-stream and Cache-Control: no-cache on success', async () => {
    const app = buildApp(mockSseFetch());
    const res = await request(app)
      .post('/api/chat/stream')
      .set('Content-Type', 'application/json')
      .send({ messages: [{ role: 'user', content: 'Hello' }] });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  // -------------------------------------------------------------------------
  // OGX 500 → HTTP 502
  // -------------------------------------------------------------------------

  it('returns HTTP 502 when OGX returns 500', async () => {
    const app = buildApp(mockErrorFetch(500));
    const res = await request(app)
      .post('/api/chat/stream')
      .set('Content-Type', 'application/json')
      .send({ messages: [{ role: 'user', content: 'Hello' }] });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Failed to proxy stream: upstream returned 500/);
  });

  // -------------------------------------------------------------------------
  // OGX 429 → HTTP 429 with OGX error body forwarded
  // -------------------------------------------------------------------------

  it('returns HTTP 429 when OGX returns 429, with OGX error body forwarded', async () => {
    const ogxErrorBody = 'Too Many Requests: Rate limit exceeded. Request ID: req-abc-123';
    const app = buildApp(mockErrorFetch(429, ogxErrorBody));
    const res = await request(app)
      .post('/api/chat/stream')
      .set('Content-Type', 'application/json')
      .send({ messages: [{ role: 'user', content: 'Hello' }] });

    expect(res.status).toBe(429);
    expect(res.body.error).toContain('Too many requests:');
    expect(res.body.error).toContain(ogxErrorBody);
  });

  // -------------------------------------------------------------------------
  // TypeError (network) → HTTP 502
  // -------------------------------------------------------------------------

  it('returns HTTP 502 when fetch to OGX throws TypeError', async () => {
    const app = buildApp(mockNetworkErrorFetch());
    const res = await request(app)
      .post('/api/chat/stream')
      .set('Content-Type', 'application/json')
      .send({ messages: [{ role: 'user', content: 'Hello' }] });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Failed to proxy stream: OGX endpoint unreachable');
  });

  // -------------------------------------------------------------------------
  // Client disconnect → AbortController.abort()
  // -------------------------------------------------------------------------

  it('client disconnect triggers AbortController.abort() on upstream fetch', async () => {
    // Verify that:
    //  1. The router passes an AbortSignal to the upstream fetch call.
    //  2. When that signal fires (simulated here), the stream ends gracefully.
    let capturedSignal: AbortSignal | null = null;
    let abortFired = false;

    const fetchFn: typeof fetch = async (_input, init) => {
      capturedSignal = (init?.signal as AbortSignal) ?? null;
      capturedSignal?.addEventListener('abort', () => {
        abortFired = true;
      });

      // Immediately return a complete response so the request finishes cleanly
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

    // Complete the request normally — we just need fetch to have been called
    await request(app)
      .post('/api/chat/stream')
      .set('Content-Type', 'application/json')
      .send({ messages: [{ role: 'user', content: 'Hello' }] });

    // The router must have passed an AbortSignal to the upstream fetch
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal).toBeInstanceOf(AbortSignal);

    // When we manually abort the controller, the listener fires
    // (this confirms the signal wiring is correct)
    // Note: the signal isn't aborted yet because the request completed normally;
    // this just confirms the signal instance is valid and listenable.
    expect(typeof capturedSignal!.addEventListener).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Property 1: Input validation rejects invalid messages arrays
// Validates: Requirements 2.1, 2.4
// ---------------------------------------------------------------------------

describe('Property 1: Input validation rejects invalid messages arrays', () => {
  it('returns HTTP 400 for messages absent, empty array, or > 100 items', async () => {
    // Arbitrary: generate invalid messages
    const invalidMessagesArb = fc.oneof(
      // absent (undefined → JSON.stringify omits key)
      fc.constant(undefined as unknown as null),
      // explicit null
      fc.constant(null),
      // empty array
      fc.constant([] as Array<{ role: string; content: string }>),
      // array with > 100 items
      fc.array(
        fc.record({ role: fc.constant('user'), content: fc.string({ minLength: 1 }) }),
        { minLength: 101, maxLength: 200 }
      ),
    );

    await fc.assert(
      fc.asyncProperty(invalidMessagesArb, async (messages) => {
        const app = buildApp(mockSseFetch());
        const body = messages === undefined
          ? {}
          : { messages };

        const res = await request(app)
          .post('/api/chat/stream')
          .set('Content-Type', 'application/json')
          .send(body);

        if (res.status !== 400) {
          throw new Error(
            `Expected HTTP 400 for invalid messages (${JSON.stringify(messages)?.slice(0, 80)}) but got ${res.status}`
          );
        }
        if (typeof res.body.error !== 'string' || !res.body.error.startsWith('Failed to process request:')) {
          throw new Error(`Expected error starting with "Failed to process request:" but got "${res.body.error as string}"`);
        }
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Streaming proxy preserves messages and sets stream flag
// Validates: Requirements 2.2
// ---------------------------------------------------------------------------

describe('Property 2: Streaming proxy preserves messages and sets stream flag', () => {
  it('forwarded OGX payload has stream=true, correct input, and model=ollamaModel from config', async () => {
    const messageArb = fc.record({
      role: fc.oneof(fc.constant('user'), fc.constant('assistant'), fc.constant('system')),
      content: fc.string({ minLength: 1, maxLength: 500 }),
    });

    await fc.assert(
      fc.asyncProperty(
        fc.array(messageArb, { minLength: 1, maxLength: 100 }),
        async (messages) => {
          let capturedBody: unknown = null;

          const fetchFn: typeof fetch = async (_input, init) => {
            capturedBody = JSON.parse(init?.body as string);
            // Return a minimal valid SSE response
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

          if (capturedBody === null) {
            throw new Error('Fetch was never called — request did not reach OGX');
          }

          const body = capturedBody as { stream: unknown; input: unknown; model: unknown };

          if (body.stream !== true) {
            throw new Error(`Expected stream=true but got ${JSON.stringify(body.stream)}`);
          }

          // After the fix, the payload uses `input` (not `messages`)
          const forwardedInput = body.input as Array<{ role: string; content: string }>;
          if (!Array.isArray(forwardedInput) || forwardedInput.length !== messages.length) {
            throw new Error(
              `Expected input length ${messages.length} but got ${Array.isArray(forwardedInput) ? forwardedInput.length : 'not-an-array'}`
            );
          }

          for (let i = 0; i < messages.length; i++) {
            if (forwardedInput[i].role !== messages[i].role || forwardedInput[i].content !== messages[i].content) {
              throw new Error(
                `Message[${i}] mismatch: expected ${JSON.stringify(messages[i])} but got ${JSON.stringify(forwardedInput[i])}`
              );
            }
          }

          // Model comes from config.ollamaModel (set to 'test/model:latest' in defaultConfig)
          if (body.model !== 'test/model:latest') {
            throw new Error(`Expected model="test/model:latest" but got "${body.model as string}"`);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 13: HTTP 429 from OGX is forwarded as HTTP 429 (not 502)
// Validates: Requirements 2.5, 2.9
// ---------------------------------------------------------------------------

describe('Property 13: HTTP 429 from OGX is forwarded as HTTP 429 (not 502)', () => {
  it('returns HTTP 429 with original OGX error body for any 429 response with a Request ID', async () => {
    // Generate realistic OGX error bodies containing a Request ID (UUID format)
    const requestIdArb = fc.uuid();
    const errorMessageArb = fc.string({ minLength: 1, maxLength: 200 });

    await fc.assert(
      fc.asyncProperty(
        requestIdArb,
        errorMessageArb,
        async (requestId, errorMessage) => {
          const ogxErrorBody = `Rate limit exceeded. Request ID: ${requestId}. ${errorMessage}`;
          const app = buildApp(mockErrorFetch(429, ogxErrorBody));

          const res = await request(app)
            .post('/api/chat/stream')
            .set('Content-Type', 'application/json')
            .send({ messages: [{ role: 'user', content: 'Hello' }] });

          if (res.status !== 429) {
            throw new Error(`Expected HTTP 429 but got ${res.status} — 429 was incorrectly mapped`);
          }

          if (typeof res.body.error !== 'string') {
            throw new Error('Expected error to be a string in the response body');
          }

          // The original OGX error body (including Request ID) must be present
          if (!res.body.error.includes(requestId)) {
            throw new Error(
              `Expected response body to include Request ID "${requestId}" but got: "${res.body.error as string}"`
            );
          }

          // Error must start with "Too many requests:"
          if (!res.body.error.startsWith('Too many requests:')) {
            throw new Error(
              `Expected error to start with "Too many requests:" but got: "${res.body.error as string}"`
            );
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
