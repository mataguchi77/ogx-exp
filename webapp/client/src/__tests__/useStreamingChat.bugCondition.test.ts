/**
 * Bug Condition Exploration Test — Stream Termination Does Not Handle response.completed
 *
 * Property 1: Bug Condition - useStreamingChat only terminates on `data: [DONE]`,
 * not on `response.completed` event type used by the Responses API.
 *
 * This test encodes the EXPECTED (fixed) behavior. It is expected to FAIL on unfixed code,
 * which confirms the bug exists. Once the fix is implemented, this test will pass.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useStreamingChat } from '../hooks/useStreamingChat';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/**
 * Build a ReadableStream that emits the provided SSE text and then closes.
 */
function makeSseStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/**
 * Suspend until isStreaming transitions back to false.
 */
async function waitForStreamingToEnd(
  result: { current: { isStreaming: boolean } },
) {
  await waitFor(() => expect(result.current.isStreaming).toBe(false), {
    timeout: 3000,
  });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Bug Condition Tests — Stream Termination
// ---------------------------------------------------------------------------

describe('Bug Condition Exploration: Stream termination with response.completed', () => {
  // -------------------------------------------------------------------------
  // Test 6: Stream should terminate on `event: response.completed`
  // -------------------------------------------------------------------------
  it('should recognize response.completed as stream termination signal and commit buffer', async () => {
    // Simulate Responses API SSE format:
    // event: response.output_text.delta
    // data: {"type":"response.output_text.delta","delta":"Hello"}
    //
    // event: response.output_text.delta
    // data: {"type":"response.output_text.delta","delta":" World"}
    //
    // event: response.completed
    // data: {"type":"response.completed","response":{"id":"resp_123","status":"completed"}}
    const sseBody = [
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"Hello"}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":" World"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_123","status":"completed"}}',
      '',
    ].join('\n');

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeSseStream(sseBody), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );
    vi.stubGlobal('fetch', mockFetch);

    const { result } = renderHook(() => useStreamingChat());

    await act(async () => {
      await result.current.sendMessage('hello');
    });

    await waitForStreamingToEnd(result);

    // Assert: The assistant message should be committed with the concatenated deltas
    const assistantMsg = result.current.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toBe('Hello World');

    // Assert: The message should NOT be marked as incomplete
    // (incomplete means stream ended without proper termination)
    expect((assistantMsg as Record<string, unknown>).isIncomplete).toBeFalsy();
  });
});
