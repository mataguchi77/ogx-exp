import { Router, type Request, type Response } from 'express';
import type { ChatMessage, ChatStreamRequestBody } from './types.js';

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
 * @param fetchFn - Optional fetch override for testing; defaults to native fetch.
 */
export function createChatRouter(fetchFn?: typeof fetch): Router {
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

    // 2. Resolve OGX base URL (Requirement 2.8)
    const ogxBaseUrl = process.env.OGX_BASE_URL ?? 'http://localhost:8321';

    // 3. Build OGX Chat Completions payload (Requirement 2.2)
    const model = process.env.OLLAMA_MODEL ?? 'ollama/llama3.1:8b';
    const ogxPayload = {
      model,
      messages: messages as ChatMessage[],
      stream: true,
    };

    // 4. Attach AbortController; cancel upstream fetch on client disconnect (Requirement 2.6)
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
      // 5. Forward to OGX POST /v1/chat/completions (Requirement 2.2)
      const ogxResponse = await doFetch(`${ogxBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ogxPayload),
        signal: controller.signal,
      });

      // 6. Handle OGX 429 — forward as 429 with original error body (Requirement 2.9)
      if (ogxResponse.status === 429) {
        const ogxErrorBody = await ogxResponse.text();
        res.status(429).json({
          error: `Too many requests: ${ogxErrorBody}`,
        });
        return;
      }

      // 7. Handle other OGX non-2xx → 502 (Requirement 2.5)
      if (!ogxResponse.ok) {
        res.status(502).json({
          error: `Failed to proxy stream: upstream returned ${ogxResponse.status}`,
        });
        return;
      }

      // 8. Set SSE headers and pipe raw bytes to browser (Requirement 2.3)
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
      // 9. Network errors (TypeError from fetch) → 502 (Requirement 2.7)
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
