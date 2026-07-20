/**
 * Bug Condition Exploration Test — Chat Router Uses Chat Completions Instead of Responses API
 *
 * Property 1: Bug Condition - Chat Router Uses Chat Completions Instead of Responses API (Both RAG Sources)
 *
 * These tests encode the EXPECTED (fixed) behavior. They are expected to FAIL on unfixed code,
 * which confirms the bug exists. Once the fix is implemented, these tests will pass.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createChatRouter } from '../chatRouter.js';
import type { AppConfig } from '../types.js';
import type { TokenManager } from '../tokenManager.js';
import type { RagConfig } from '../ragConfig.js';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/**
 * Mock AppConfig for testing.
 */
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

/**
 * Mock TokenManager with a configurable token value.
 */
function mockTokenManager(token: string | null): TokenManager {
  return {
    getToken: () => token,
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
 * Mock RagConfig for Ollama with a vector store ID.
 */
function ollamaRagConfig(vectorStoreId: string | null): RagConfig {
  return {
    ragSource: 'ollama',
    embeddingModel: 'ollama/mxbai-embed-large',
    embeddingDimension: 1024,
    vectorStoreName: 'rag-documents',
    vectorStoreId,
  };
}

/**
 * Mock RagConfig for AWS.
 */
function awsRagConfig(): RagConfig {
  return {
    ragSource: 'aws',
    embeddingModel: 'ollama/mxbai-embed-large',
    embeddingDimension: 1024,
    vectorStoreName: 'rag-documents',
    vectorStoreId: null,
  };
}

/**
 * Creates a mock fetch that captures the request URL and body,
 * then returns a minimal valid SSE response.
 */
function createCapturingFetch(): {
  fetchFn: typeof fetch;
  getCapturedUrl: () => string | null;
  getCapturedBody: () => Record<string, unknown> | null;
} {
  let capturedUrl: string | null = null;
  let capturedBody: Record<string, unknown> | null = null;

  const fetchFn: typeof fetch = async (input, init) => {
    capturedUrl = typeof input === 'string' ? input : (input as Request).url;
    capturedBody = JSON.parse(init?.body as string);

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"type":"response.output_text.delta","delta":"hi"}\n\ndata: [DONE]\n\n')
        );
        controller.close();
      },
    });
    return new Response(readable, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };

  return {
    fetchFn,
    getCapturedUrl: () => capturedUrl,
    getCapturedBody: () => capturedBody,
  };
}

/**
 * Builds a test Express app with the chat router.
 * This attempts to call createChatRouter with the FIXED signature.
 * On unfixed code, it will either fail to compile or the params will be ignored.
 */
function buildAppWithConfig(
  config: AppConfig,
  tokenManager: TokenManager,
  ragConfig: RagConfig,
  fetchFn: typeof fetch,
): express.Express {
  const app = express();
  app.use(express.json());
  // The fixed signature: createChatRouter(config, tokenManager, ragConfig, fetchFn)
  // On unfixed code, createChatRouter only accepts (fetchFn?) so extra args are ignored
  const router = (createChatRouter as Function)(config, tokenManager, ragConfig, fetchFn);
  app.use('/api/chat/stream', router);
  return app;
}

// ---------------------------------------------------------------------------
// Bug Condition Tests
// ---------------------------------------------------------------------------

describe('Bug Condition Exploration: Chat Router Uses Chat Completions Instead of Responses API', () => {
  // -------------------------------------------------------------------------
  // Test 1: Ollama RAG with vectorStoreId → should use /v1/responses with file_search
  // -------------------------------------------------------------------------
  describe('Ollama RAG bug condition', () => {
    it('should call /v1/responses (not /v1/chat/completions) with file_search tool when ragSource=ollama and vectorStoreId is set', async () => {
      const config = mockConfig();
      const tokenManager = mockTokenManager(null);
      const ragConfig = ollamaRagConfig('vs_1ae3f815-abc-123');
      const { fetchFn, getCapturedUrl, getCapturedBody } = createCapturingFetch();

      const app = buildAppWithConfig(config, tokenManager, ragConfig, fetchFn);

      await request(app)
        .post('/api/chat/stream')
        .set('Content-Type', 'application/json')
        .send({ messages: [{ role: 'user', content: 'What does our architecture doc say?' }] });

      const url = getCapturedUrl();
      const body = getCapturedBody();

      // Assert: URL should be /v1/responses (not /v1/chat/completions)
      expect(url).toBe(`${config.ogxBaseUrl}/v1/responses`);
      expect(url).not.toContain('/v1/chat/completions');

      // Assert: payload should use `input` field (not `messages`)
      expect(body).toHaveProperty('input');
      expect(body).not.toHaveProperty('messages');

      // Assert: payload should contain file_search tool with vectorStoreId
      expect(body!.tools).toEqual(
        expect.arrayContaining([
          { type: 'file_search', vector_store_ids: ['vs_1ae3f815-abc-123'] },
        ])
      );

      // Assert: stream should be true
      expect(body!.stream).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Test 2: AWS RAG with valid token → should use /v1/responses with mcp tool
  // -------------------------------------------------------------------------
  describe('AWS RAG bug condition', () => {
    it('should call /v1/responses with mcp tool when ragSource=aws and token is available', async () => {
      const config = mockConfig();
      const bearerToken = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.test-token';
      const tokenManager = mockTokenManager(bearerToken);
      const ragConfig = awsRagConfig();
      const { fetchFn, getCapturedUrl, getCapturedBody } = createCapturingFetch();

      const app = buildAppWithConfig(config, tokenManager, ragConfig, fetchFn);

      await request(app)
        .post('/api/chat/stream')
        .set('Content-Type', 'application/json')
        .send({ messages: [{ role: 'user', content: 'Summarize the knowledge base' }] });

      const url = getCapturedUrl();
      const body = getCapturedBody();

      // Assert: URL should be /v1/responses
      expect(url).toBe(`${config.ogxBaseUrl}/v1/responses`);

      // Assert: payload should contain mcp tool with gateway URL and bearer token
      expect(body!.tools).toEqual(
        expect.arrayContaining([
          {
            type: 'mcp',
            server_url: config.gatewayUrl,
            server_label: 'bedrock-agentcore',
            authorization: bearerToken,
          },
        ])
      );

      // Assert: payload should use `input` field (not `messages`)
      expect(body).toHaveProperty('input');

      // Assert: stream should be true
      expect(body!.stream).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Test 3: AWS RAG with null token → should return 503
  // -------------------------------------------------------------------------
  describe('AWS RAG token unavailable', () => {
    it('should return 503 with "OAuth2 token unavailable" when ragSource=aws and token is null', async () => {
      const config = mockConfig();
      const tokenManager = mockTokenManager(null);
      const ragConfig = awsRagConfig();
      const { fetchFn, getCapturedUrl } = createCapturingFetch();

      const app = buildAppWithConfig(config, tokenManager, ragConfig, fetchFn);

      const res = await request(app)
        .post('/api/chat/stream')
        .set('Content-Type', 'application/json')
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      // Assert: should return 503
      expect(res.status).toBe(503);

      // Assert: error should mention OAuth2 token unavailable
      expect(res.body.error).toContain('OAuth2 token unavailable');

      // Assert: no upstream call should have been made
      expect(getCapturedUrl()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Test 4: No-tool fallback — Ollama without vectorStoreId → /v1/responses with empty tools
  // -------------------------------------------------------------------------
  describe('No-tool fallback', () => {
    it('should call /v1/responses with empty tools when ragSource=ollama and no vectorStoreId', async () => {
      const config = mockConfig();
      const tokenManager = mockTokenManager(null);
      const ragConfig = ollamaRagConfig(null);
      const { fetchFn, getCapturedUrl, getCapturedBody } = createCapturingFetch();

      const app = buildAppWithConfig(config, tokenManager, ragConfig, fetchFn);

      await request(app)
        .post('/api/chat/stream')
        .set('Content-Type', 'application/json')
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      const url = getCapturedUrl();
      const body = getCapturedBody();

      // Assert: URL should still be /v1/responses (not /v1/chat/completions)
      expect(url).toBe(`${config.ogxBaseUrl}/v1/responses`);

      // Assert: tools should be an empty array
      expect(body!.tools).toEqual([]);

      // Assert: payload should use `input` field (not `messages`)
      expect(body).toHaveProperty('input');
      expect(body).not.toHaveProperty('messages');

      // Assert: stream should be true
      expect(body!.stream).toBe(true);
    });
  });
});
