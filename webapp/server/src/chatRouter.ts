import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { AppConfig, ChatMessage, ChatStreamRequestBody, OgxMcpTool, OgxFileSearchTool } from './types.js';
import type { TokenManager } from './tokenManager.js';
import type { RagConfig } from './ragConfig.js';
import { getVectorStoreId } from './ragConfig.js';

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Creates an Express Router for POST /api/chat/stream.
 *
 * Validates the `messages` array, builds an OGX Chat Completions payload with
 * `stream: true`, and pipes the raw SSE bytes from OGX directly to the browser
 * without buffering.
 *
 * @param config       - Loaded AppConfig (ogxBaseUrl, ollamaModel, gatewayUrl, …)
 * @param tokenManager - TokenManager instance for bearer token retrieval
 * @param ragConfig    - RAG configuration for tool selection
 * @param fetchFn      - Optional fetch override for testing; defaults to native fetch.
 */
export function createChatRouter(config: AppConfig, tokenManager: TokenManager, ragConfig: RagConfig, fetchFn?: typeof fetch): Router {
  const doFetch = fetchFn ?? globalThis.fetch;
  const router = Router();

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    // 1. Validate messages array (Requirement 2.4)
    const body = req.body as Partial<ChatStreamRequestBody>;
    const messages = body.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({
        error: 'Failed to process request: messages array is required and must not be empty',
      });
      return;
    }

    if (messages.length > 100) {
      res.status(400).json({
        error: 'Failed to process request: messages array must not exceed 100 items',
      });
      return;
    }

    // 2. Token check (only for AWS path)
    let bearerToken: string | null = null;
    if (ragConfig.ragSource === 'aws') {
      bearerToken = tokenManager.getToken();
      if (bearerToken === null) {
        res.status(503).json({
          error: 'Failed to process request: OAuth2 token unavailable',
        });
        return;
      }
    }

    // 3. Build tools array based on ragConfig
    const tools: Array<OgxMcpTool | OgxFileSearchTool> = [];
    if (ragConfig.ragSource === 'aws') {
      tools.push({
        type: 'mcp',
        server_url: config.gatewayUrl,
        server_label: 'bedrock-agentcore',
        authorization: bearerToken!,
      });
    } else {
      const vectorStoreId = getVectorStoreId(ragConfig);
      if (vectorStoreId != null && vectorStoreId !== '') {
        tools.push({ type: 'file_search', vector_store_ids: [vectorStoreId] });
      }
    }

    // 4. Build OGX Responses API payload
    const ogxPayload: Record<string, unknown> = {
      model: config.ollamaModel,
      input: messages as ChatMessage[],
      tools,
    };

    // For the AWS path, instruct the model to use a stable sessionId when calling
    // the Bedrock AgentCore tool — without this, the gateway rejects the call.
    // Also, AWS MCP tool calls do not support streaming reliably — OGX's agentic
    // loop with MCP tools hangs in streaming mode. Use non-streaming for AWS.
    const useStreaming = ragConfig.ragSource !== 'aws';
    if (ragConfig.ragSource === 'aws') {
      const sessionId = uuidv4();
      ogxPayload.instructions = `When calling the multimodal-agent___invoke_bedrock_agent tool, always use sessionId "${sessionId}". Do not invent or guess a sessionId.`;
    }
    if (useStreaming) {
      ogxPayload.stream = true;
    }

    console.info(`Chat stream: ragSource=${ragConfig.ragSource}, tools=${JSON.stringify(tools.map(t => t.type))}, model=${config.ollamaModel}, streaming=${useStreaming}`);

    // 5. Attach AbortController; cancel upstream fetch on client disconnect
    const controller = new AbortController();
    let streamingStarted = false;
    req.on('close', () => {
      // Only abort if we have already started piping — otherwise the premature
      // close races with the upstream fetch and causes an empty response.
      if (streamingStarted) {
        controller.abort();
      }
    });

    try {
      // 6. Forward to OGX POST /v1/responses
      const ogxResponse = await doFetch(`${config.ogxBaseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ogxPayload),
        signal: controller.signal,
      });

      // 7. Handle OGX 429 — forward as 429 with original error body
      if (ogxResponse.status === 429) {
        const ogxErrorBody = await ogxResponse.text();
        res.status(429).json({
          error: `Too many requests: ${ogxErrorBody}`,
        });
        return;
      }

      // 8. Handle other OGX non-2xx → 502
      if (!ogxResponse.ok) {
        res.status(502).json({
          error: `Failed to proxy stream: upstream returned ${ogxResponse.status}`,
        });
        return;
      }

      // 9. Handle response based on streaming mode
      if (!useStreaming) {
        // Non-streaming path (AWS MCP): Read the full JSON response from OGX,
        // extract text content, and emit it as SSE events for the frontend.
        const ogxData = await ogxResponse.json() as {
          output?: Array<{
            type: string;
            content?: Array<{ type: string; text?: string }>;
          }>;
        };

        // Extract text from the response output (same logic as agentRouter.extractContent)
        const textParts: string[] = [];
        for (const item of ogxData.output ?? []) {
          if (item.type !== 'message' || !item.content) continue;
          for (const block of item.content) {
            if ((block.type === 'output_text' || block.type === 'text') && block.text) {
              textParts.push(block.text);
            }
          }
        }

        const fullText = textParts.join('\n');

        // Set SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        // Emit the full text as a single delta event in Responses API SSE format
        if (fullText) {
          const deltaEvent = JSON.stringify({ type: 'response.output_text.delta', delta: fullText });
          res.write(`event: response.output_text.delta\ndata: ${deltaEvent}\n\n`);
        }

        // Emit the completion event
        const completedEvent = JSON.stringify({ type: 'response.completed', response: {} });
        res.write(`event: response.completed\ndata: ${completedEvent}\n\n`);
        res.end();
        return;
      }

      // 10. Streaming path (Ollama): Set SSE headers and pipe raw bytes to browser
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Pipe the upstream SSE response body directly to the client without buffering.
      // Node.js fetch returns a Web Streams ReadableStream; pipe it using the async iterator.
      if (!ogxResponse.body) {
        res.status(502).json({
          error: 'Failed to proxy stream: upstream returned empty body',
        });
        return;
      }

      const reader = ogxResponse.body.getReader();
      const decoder = new TextDecoder();
      streamingStarted = true;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
        res.end();
      } finally {
        reader.releaseLock();
      }
    } catch (err: unknown) {
      // 10. Network errors (TypeError from fetch) → 502
      if (err instanceof TypeError) {
        res.status(502).json({
          error: 'Failed to proxy stream: OGX endpoint unreachable',
        });
        return;
      }

      // AbortError from client disconnect — response already piping or connection closed;
      // end the response gracefully without sending an error payload.
      if (err instanceof Error && err.name === 'AbortError') {
        res.end();
        return;
      }

      // Unexpected errors
      res.status(500).json({
        error: 'Failed to process request: internal server error',
      });
    }
  });

  return router;
}
