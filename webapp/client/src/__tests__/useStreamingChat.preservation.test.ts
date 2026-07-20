/**
 * Preservation Property Tests for useStreamingChat hook
 *
 * These tests encode the CURRENT behavior of stopStreaming() and clearConversation()
 * to ensure no regressions are introduced when the fix is applied.
 *
 * Feature: frontend-rag-routing, Property 2: Preservation
 * **Validates: Requirements 3.5, 3.6**
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import * as fc from 'fast-check';
import { useStreamingChat } from '../hooks/useStreamingChat';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSseResponse(deltas: string[]): Response {
  const encoder = new TextEncoder();
  const lines = [
    ...deltas.map((d) =>
      `data: ${JSON.stringify({ id: 'x', choices: [{ delta: { content: d }, finish_reason: null }] })}`,
    ),
    'data: [DONE]',
  ];
  const body = lines.map((l) => `${l}\n`).join('') + '\n';
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(readable, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function waitForStreamingToEnd(result: { current: { isStreaming: boolean } }) {
  await waitFor(() => expect(result.current.isStreaming).toBe(false), { timeout: 3000 });
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Property 2d: stopStreaming aborts fetch, commits partial buffer + "(stopped)"
// **Validates: Requirements 3.5**
// ---------------------------------------------------------------------------

describe('Preservation Property 2d: stopStreaming commits partial buffer with "(stopped)" and transitions to idle', () => {
  it('stopStreaming aborts fetch, committed message contains buffer + "(stopped)", isStreaming becomes false', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate partial buffer content that might have arrived before stop
        fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s.trim().length > 0),
        async (partialContent) => {
          const encoder = new TextEncoder();
          let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
          let fetchAborted = false;

          const stallStream = new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
              // Emit the partial content token
              const line = `data: ${JSON.stringify({
                id: 'x',
                choices: [{ delta: { content: partialContent }, finish_reason: null }],
              })}\n\n`;
              controller.enqueue(encoder.encode(line));
              // Do NOT close — stream stalls
            },
          });

          const mockFetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
            // Track abort
            if (init?.signal) {
              init.signal.addEventListener('abort', () => {
                fetchAborted = true;
              });
            }
            return Promise.resolve(
              new Response(stallStream, {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' },
              }),
            );
          });
          vi.stubGlobal('fetch', mockFetch);

          const { result } = renderHook(() => useStreamingChat());

          // Start streaming (don't await — it stalls)
          act(() => {
            void result.current.sendMessage('test');
          });

          // Wait for streaming to begin and partial content to arrive
          await waitFor(() => expect(result.current.isStreaming).toBe(true), { timeout: 2000 });
          await waitFor(
            () => expect(result.current.streamingBuffer).toContain(partialContent),
            { timeout: 2000 },
          );

          // Stop the stream
          act(() => {
            result.current.stopStreaming();
          });

          // Close the stalled stream controller to unblock reader
          if (streamController) {
            (streamController as ReadableStreamDefaultController<Uint8Array>).close();
          }

          await waitForStreamingToEnd(result);

          // Verify behavior:
          // 1. Fetch was aborted
          expect(fetchAborted).toBe(true);

          // 2. Committed message contains partial content + "(stopped)"
          const stoppedMsg = result.current.messages.find((m) => m.isStopped === true);
          expect(stoppedMsg).toBeDefined();
          expect(stoppedMsg!.content).toContain(partialContent);
          expect(stoppedMsg!.content).toContain('(stopped)');

          // 3. Transitioned to idle
          expect(result.current.isStreaming).toBe(false);
          expect(result.current.streamingBuffer).toBeNull();

          vi.restoreAllMocks();
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2e: clearConversation resets messages without network requests
// **Validates: Requirements 3.6**
// ---------------------------------------------------------------------------

describe('Preservation Property 2e: clearConversation resets messages without network requests', () => {
  it('clearConversation empties messages array and makes no fetch calls', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate 1-5 user messages to build up history
        fc.array(
          fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
          { minLength: 1, maxLength: 5 },
        ),
        async (userMessages) => {
          const mockFetch = vi.fn().mockImplementation(() =>
            Promise.resolve(makeSseResponse(['reply'])),
          );
          vi.stubGlobal('fetch', mockFetch);

          const { result } = renderHook(() => useStreamingChat());

          // Build up conversation history
          for (const msg of userMessages) {
            await act(async () => {
              await result.current.sendMessage(msg);
            });
            await waitForStreamingToEnd(result);
          }

          // Verify we have messages
          expect(result.current.messages.length).toBeGreaterThan(0);

          // Track fetch call count before clearConversation
          const fetchCallsBefore = mockFetch.mock.calls.length;

          // Call clearConversation
          act(() => {
            result.current.clearConversation();
          });

          // Verify: messages are empty
          expect(result.current.messages).toEqual([]);

          // Verify: no additional fetch calls were made
          expect(mockFetch.mock.calls.length).toBe(fetchCallsBefore);

          vi.restoreAllMocks();
        },
      ),
      { numRuns: 50 },
    );
  });
});
