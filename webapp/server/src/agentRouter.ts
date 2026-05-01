import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { AppConfig, ContentBlock, OgxMcpTool, OgxResponsesOutput, OgxResponsesRequest } from './types.js';
import type { TokenManager } from './tokenManager.js';

// ---------------------------------------------------------------------------
// Pure helper functions (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Builds the OGX Responses API payload.
 * Exported for Property 7 test.
 */
export function buildOgxPayload(
  query: string,
  bearerToken: string,
  config: AppConfig
): OgxResponsesRequest {
  const tool: OgxMcpTool = {
    type: 'mcp',
    server_url: config.gatewayUrl,
    server_label: 'bedrock-agentcore',
    authorization: bearerToken,
  };

  return {
    model: config.ollamaModel,
    input: [{ role: 'user', content: query }],
    tools: [tool],
  };
}

/**
 * Extracts text and image content from an OGX Responses API output array.
 * Exported for Property 9 test.
 */
export function extractContent(ogxOutput: OgxResponsesOutput['output']): ContentBlock {
  const text: string[] = [];
  const images: ContentBlock['images'] = [];

  for (const item of ogxOutput) {
    // Only extract content from message items (skip mcp_list_tools, mcp_call, etc.)
    if (item.type !== 'message' || !item.content) continue;
    for (const block of item.content) {
      if ((block.type === 'output_text' || block.type === 'text') && block.text !== undefined) {
        text.push(block.text);
      } else if (block.type === 'image_url' && block.image_url) {
        images.push({
          alt: block.image_url.detail ?? 'image',
          url: block.image_url.url,
        });
      }
    }
  }

  return { text, images };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Creates an Express Router for POST /api/invoke-agent.
 *
 * @param config       - Loaded AppConfig (gatewayUrl, ollamaModel, ogxBaseUrl, …)
 * @param tokenManager - TokenManager instance for bearer token retrieval
 * @param fetchFn      - Optional fetch override for testing
 */
export function createAgentRouter(
  config: AppConfig,
  tokenManager: TokenManager,
  fetchFn?: typeof fetch
): Router {
  const doFetch = fetchFn ?? globalThis.fetch;
  const router = Router();

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    // 1. Content-Type validation
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.includes('application/json')) {
      res.status(415).json({
        success: false,
        error: 'Failed to process request: unsupported content type',
      });
      return;
    }

    const { query, sessionId: requestSessionId } = req.body as {
      query?: unknown;
      sessionId?: unknown;
    };

    // 2a. Query presence validation
    if (query === undefined || query === null || query === '') {
      res.status(400).json({
        success: false,
        error: 'Failed to process request: query is required',
      });
      return;
    }

    // 2b. Query type check (must be a string)
    if (typeof query !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Failed to process request: query is required',
      });
      return;
    }

    // 2c. Query length validation — do NOT call OGX if too long
    if (query.length > 10_000) {
      res.status(400).json({
        success: false,
        error: 'Failed to process request: query exceeds maximum length',
      });
      return;
    }

    // 3. Token check
    const bearerToken = tokenManager.getToken();
    if (bearerToken === null) {
      res.status(503).json({
        success: false,
        error: 'Failed to process request: OAuth2 token unavailable',
      });
      return;
    }

    // 4. Session ID
    const sessionId =
      typeof requestSessionId === 'string' && requestSessionId.length > 0
        ? requestSessionId
        : uuidv4();

    // 5. OGX call with 30-second timeout
    const payload = buildOgxPayload(query, bearerToken, config);
    const controller = new AbortController();
    const timeoutMs = 120_000; // 120 s — Ollama cold starts can exceed 30 s
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const ogxResponse = await doFetch(`${config.ogxBaseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // 7a. OGX/gateway 4xx–5xx → 502
      if (!ogxResponse.ok) {
        res.status(502).json({
          success: false,
          error: `Failed to invoke agent: ${ogxResponse.statusText}`,
        });
        return;
      }

      const ogxData = (await ogxResponse.json()) as OgxResponsesOutput;

      // Debug: log the raw OGX response so we can see its actual shape
      console.info('OGX raw response:', JSON.stringify(ogxData, null, 2));

      // 6. Extract text and image content
      const content = extractContent(ogxData.output ?? []);

      // 8. Success response
      res.status(200).json({
        success: true,
        content,
        sessionId,
      });
    } catch (err: unknown) {
      clearTimeout(timeoutId);

      // 7b. Timeout (AbortError) → 504
      if (err instanceof Error && err.name === 'AbortError') {
        res.status(504).json({
          success: false,
          error: 'Failed to invoke agent: gateway timeout',
        });
        return;
      }

      // 7c. Unexpected errors → 500
      res.status(500).json({
        success: false,
        error: 'Failed to process request: internal server error',
      });
    }
  });

  return router;
}
