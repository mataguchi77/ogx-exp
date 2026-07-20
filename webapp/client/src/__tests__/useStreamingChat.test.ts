/**
 * Property-based tests for the useStreamingChat hook.
 *
 * Tests 7.2–7.8 from the frontend-streaming-app spec.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import * as fc from 'fast-check';
import { useStreamingChat } from '../hooks/useStreamingChat';

// ─── SSE stream helpers ────────────────────────────────────────────────────────

/**
 * Build a ReadableStream that emits the provided SSE lines and then closes.
 * Each line is suffixed with "\n", and chunks end with a blank line ("\n\n").
 */
function makeSseStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const body = lines.map((l) => `${l}\n`).join('') + '\n';
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
}

/**
 * Return a mock fetch Response that streams the given SSE delta tokens and then
 * emits data: [DONE].
 */
function makeSseResponse(deltas: string[]): Response {
  const lines = [
    ...deltas.map((d) =>
      `data: ${JSON.stringify({ id: 'x', choices: [{ delta: { content: d }, finish_reason: null }] })}`,
    ),
    'data: [DONE]',
  ];
  return new Response(makeSseStream(lines), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/**
 * Return a mock fetch Response for an HTTP error (no body stream needed).
 */
function makeErrorResponse(status: number, body: unknown = { error: `HTTP ${status}` }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Suspend until isStreaming transitions back to false (stream done/error). */
async function waitForStreamingToEnd(
  result: { current: { isStreaming: boolean } },
) {
  await waitFor(() => expect(result.current.isStreaming).toBe(false), {
    timeout: 3000,
  });
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Property 3: SSE token accumulation is exact concatenation ────────────────
// Feature: frontend-streaming-app, Property 3: SSE token accumulation is exact concatenation
// **Validates: Requirements 5.1, 5.5, 8.2**
describe('Property 3: SSE token accumulation is exact concatenation', () => {
  it('committed message content equals joined delta array', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate between 1 and 20 delta strings (any printable content)
        fc.array(fc.string({ minLength: 0, maxLength: 50 }), { minLength: 1, maxLength: 20 }),
        async (deltas) => {
          const mockFetch = vi.fn().mockResolvedValue(makeSseResponse(deltas));
          vi.stubGlobal('fetch', mockFetch);

          const { result } = renderHook(() => useStreamingChat());

          await act(async () => {
            await result.current.sendMessage('hello');
          });

          await waitForStreamingToEnd(result);

          // The last message should be the assistant message with exact concatenation
          const assistant = result.current.messages.find((m) => m.role === 'assistant');
          expect(assistant).toBeDefined();
          expect(assistant!.content).toBe(deltas.join(''));
          expect(assistant!.isError).toBeFalsy();

          vi.restoreAllMocks();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 6: Whitespace-only input is rejected ────────────────────────────
// Feature: frontend-streaming-app, Property 6: Whitespace-only input is rejected
// **Validates: Requirements 4.4**
describe('Property 6: Whitespace-only input is rejected', () => {
  it('does not call fetch and leaves messages unchanged for whitespace-only input', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Unicode whitespace characters: space, tab, newline, carriage return, etc.
        fc.stringOf(
          fc.constantFrom(' ', '\t', '\n', '\r', '\u00A0', '\u2003', '\u3000', '\u000C', '\u000B'),
          { minLength: 1, maxLength: 30 },
        ),
        async (whitespaceInput) => {
          const mockFetch = vi.fn();
          vi.stubGlobal('fetch', mockFetch);

          const { result } = renderHook(() => useStreamingChat());
          const messagesBefore = result.current.messages.length;

          await act(async () => {
            await result.current.sendMessage(whitespaceInput);
          });

          expect(mockFetch).not.toHaveBeenCalled();
          expect(result.current.messages.length).toBe(messagesBefore);

          vi.restoreAllMocks();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 7: Full conversation history included in each request ───────────
// Feature: frontend-streaming-app, Property 7: Full conversation history included in each request
// **Validates: Requirements 4.2, 8.2**
describe('Property 7: Full conversation history included in each request', () => {
  it('fetch body contains N+1 messages in insertion order', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate 0–50 prior messages
        fc.array(
          fc.record({
            role: fc.constantFrom('user' as const, 'assistant' as const),
            content: fc.string({ minLength: 1, maxLength: 100 }),
          }),
          { minLength: 0, maxLength: 50 },
        ),
        // New user input
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim() !== ''),
        async (priorMessages, newInput) => {
          let capturedBody: { messages: Array<{ role: string; content: string }> } | null = null;

          const mockFetch = vi.fn().mockImplementation((_url: string, options: RequestInit) => {
            capturedBody = JSON.parse(options.body as string) as {
              messages: Array<{ role: string; content: string }>;
            };
            return Promise.resolve(makeSseResponse(['ok']));
          });
          vi.stubGlobal('fetch', mockFetch);

          const { result } = renderHook(() => useStreamingChat());

          // Seed the hook with prior messages by mutating internal state via
          // sequential sendMessage calls is too slow; instead we verify the
          // shape of a single fresh send with an empty history.
          // For histories of length > 0, we need to pre-populate the hook.
          // We do that by sending each prior message and intercepting them.
          // Reset state between seeded messages — use a simpler approach:
          // mount a fresh hook and call sendMessage for each prior message,
          // waiting between each.
          //
          // To keep test fast, only seed up to 5 prior messages in the property.
          const boundedPrior = priorMessages.slice(0, 5);
          const N = boundedPrior.length;

          // Build a queue of responses: one per prior message pair + final send
          let callCount = 0;
          const responseQueue: Response[] = [];

          // Each pair (user + assistant) requires one fetch call
          for (let i = 0; i < N; i++) {
            const msg = boundedPrior[i];
            if (msg.role === 'user') {
              // Respond with a single-token assistant reply
              responseQueue.push(makeSseResponse(['reply']));
            }
          }
          // Final call for the new input
          responseQueue.push(makeSseResponse(['final']));

          const queuedFetch = vi.fn().mockImplementation((_url: string, options: RequestInit) => {
            capturedBody = JSON.parse(options.body as string) as {
              messages: Array<{ role: string; content: string }>;
            };
            return Promise.resolve(responseQueue[callCount++] ?? makeSseResponse(['x']));
          });
          vi.stubGlobal('fetch', queuedFetch);

          // Send all prior user messages to build up history
          for (const msg of boundedPrior) {
            if (msg.role === 'user') {
              await act(async () => {
                await result.current.sendMessage(msg.content);
              });
              await waitForStreamingToEnd(result);
            }
          }

          // Count messages before the final send
          const historyLength = result.current.messages.length;

          // Now send the new input
          await act(async () => {
            await result.current.sendMessage(newInput);
          });
          await waitForStreamingToEnd(result);

          // Verify the fetch body
          expect(capturedBody).not.toBeNull();
          expect(capturedBody!.messages.length).toBe(historyLength + 1);

          // Last entry must be the new user message
          const lastEntry = capturedBody!.messages[capturedBody!.messages.length - 1];
          expect(lastEntry.role).toBe('user');
          expect(lastEntry.content).toBe(newInput);

          // Order: entries before the last should match the prior message list
          for (let i = 0; i < historyLength; i++) {
            expect(capturedBody!.messages[i]).toMatchObject({
              role: result.current.messages[i].role,
              content: result.current.messages[i].content,
            });
          }

          vi.restoreAllMocks();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 8: Stop commits partial buffer as "(stopped)" ──────────────────
// Feature: frontend-streaming-app, Property 8: Stop commits partial buffer as "(stopped)"
// **Validates: Requirements 6.2, 6.3**
describe('Property 8: Stop commits partial buffer as "(stopped)"', () => {
  it('committed message contains buffer text and "(stopped)" marker', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Any partial buffer content (may be empty)
        fc.string({ minLength: 0, maxLength: 100 }),
        async (partialContent) => {
          // Build a stream that emits one token and then stalls indefinitely
          // so we can call stopStreaming before [DONE] arrives.
          const encoder = new TextEncoder();
          let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

          const stallStream = new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
              if (partialContent.length > 0) {
                const line = `data: ${JSON.stringify({
                  id: 'x',
                  choices: [{ delta: { content: partialContent }, finish_reason: null }],
                })}\n\n`;
                controller.enqueue(encoder.encode(line));
              }
              // Do NOT close — stream stalls to simulate in-progress state
            },
          });

          const mockFetch = vi.fn().mockResolvedValue(
            new Response(stallStream, {
              status: 200,
              headers: { 'Content-Type': 'text/event-stream' },
            }),
          );
          vi.stubGlobal('fetch', mockFetch);

          const { result } = renderHook(() => useStreamingChat());

          // Start streaming — don't await, it will stall
          act(() => {
            void result.current.sendMessage('test');
          });

          // Wait for streaming to begin
          await waitFor(() => expect(result.current.isStreaming).toBe(true), { timeout: 2000 });

          // If there's partial content, wait for it to appear in the buffer
          if (partialContent.length > 0) {
            await waitFor(
              () => expect(result.current.streamingBuffer).toContain(partialContent),
              { timeout: 2000 },
            );
          }

          // Stop the stream
          act(() => {
            result.current.stopStreaming();
          });

          // Close the stalled stream controller to unblock any reader
          if (streamController) {
            (streamController as ReadableStreamDefaultController<Uint8Array>).close();
          }

          await waitForStreamingToEnd(result);

          // Find the stopped assistant message
          const stoppedMsg = result.current.messages.find((m) => m.isStopped === true);
          expect(stoppedMsg).toBeDefined();
          expect(stoppedMsg!.content).toContain('(stopped)');
          // The partial buffer content should be in the message
          expect(stoppedMsg!.content).toContain(partialContent);

          vi.restoreAllMocks();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 9: Error responses always re-enable controls ───────────────────
// Feature: frontend-streaming-app, Property 9: Error responses always re-enable controls
// **Validates: Requirements 7.5, 4.3**
describe('Property 9: Error responses always re-enable controls', () => {
  it('isStreaming is false after any HTTP 4xx or 5xx error', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate HTTP error status codes from 4xx and 5xx ranges
        fc.oneof(
          fc.integer({ min: 400, max: 499 }),
          fc.integer({ min: 500, max: 599 }),
        ),
        async (statusCode) => {
          const mockFetch = vi.fn().mockResolvedValue(
            makeErrorResponse(statusCode, { error: `Error ${statusCode}` }),
          );
          vi.stubGlobal('fetch', mockFetch);

          const { result } = renderHook(() => useStreamingChat());

          await act(async () => {
            await result.current.sendMessage('hello');
          });

          await waitForStreamingToEnd(result);

          // Controls must be re-enabled (isStreaming === false)
          expect(result.current.isStreaming).toBe(false);

          vi.restoreAllMocks();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 10: HTTP error codes produce visible error entries ──────────────
// Feature: frontend-streaming-app, Property 10: HTTP error codes produce visible error entries
// **Validates: Requirements 7.1, 7.2, 7.6**
describe('Property 10: HTTP error codes produce visible error entries', () => {
  it('new Message_List entry has isError: true for any 4xx or 5xx status', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.integer({ min: 400, max: 499 }),
          fc.integer({ min: 500, max: 599 }),
        ),
        async (statusCode) => {
          const mockFetch = vi.fn().mockResolvedValue(
            makeErrorResponse(statusCode, { error: `Error ${statusCode}` }),
          );
          vi.stubGlobal('fetch', mockFetch);

          const { result } = renderHook(() => useStreamingChat());

          await act(async () => {
            await result.current.sendMessage('hello');
          });

          await waitForStreamingToEnd(result);

          // There must be at least one error message in the list
          const errorMessages = result.current.messages.filter((m) => m.isError === true);
          expect(errorMessages.length).toBeGreaterThan(0);

          // The error message content must contain something distinguishable
          // (the hook sets "Error: HTTP <status>" or "Too many requests: ...")
          const latestError = errorMessages[errorMessages.length - 1];
          expect(latestError.isError).toBe(true);
          expect(latestError.content).toBeTruthy();

          vi.restoreAllMocks();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 14: HTTP 429 produces rate-limit error with Request ID ──────────
// Feature: frontend-streaming-app, Property 14: HTTP 429 from backend produces a rate-limit error entry with Request ID
// **Validates: Requirements 7.7**
describe('Property 14: HTTP 429 produces rate-limit error entry with Request ID', () => {
  it('error entry contains "Too many requests" and the Request ID', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a UUID-format request ID
        fc.uuid(),
        // Generate a human-readable error message from the backend
        fc.string({ minLength: 5, maxLength: 100 }).filter((s) => s.trim().length > 0),
        async (requestId, errorMsg) => {
          // Backend 429 response body includes the error message with the request ID embedded
          const backendError = `Too many requests: ${errorMsg} (request_id: ${requestId})`;
          const mockFetch = vi.fn().mockResolvedValue(
            makeErrorResponse(429, { error: backendError }),
          );
          vi.stubGlobal('fetch', mockFetch);

          const { result } = renderHook(() => useStreamingChat());

          await act(async () => {
            await result.current.sendMessage('hello');
          });

          await waitForStreamingToEnd(result);

          // Find the 429 error message
          const errorMessages = result.current.messages.filter((m) => m.isError === true);
          expect(errorMessages.length).toBeGreaterThan(0);

          const latestError = errorMessages[errorMessages.length - 1];
          expect(latestError.isError).toBe(true);
          // Must contain the "Too many requests" phrase
          expect(latestError.content.toLowerCase()).toContain('too many requests');
          // Must include the request ID
          expect(latestError.content).toContain(requestId);

          vi.restoreAllMocks();
        },
      ),
      { numRuns: 100 },
    );
  });
});
