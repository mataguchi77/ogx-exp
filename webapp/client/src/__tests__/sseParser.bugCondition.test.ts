/**
 * Bug Condition Exploration Test — Frontend Parser Does Not Handle Responses API Format
 *
 * Property 1: Bug Condition - parseSseLine returns null for Responses API streaming format
 *
 * This test encodes the EXPECTED (fixed) behavior. It is expected to FAIL on unfixed code,
 * which confirms the bug exists. Once the fix is implemented, this test will pass.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
 */

import { describe, it, expect } from 'vitest';
import { parseSseLine } from '../utils/sseParser';

// ---------------------------------------------------------------------------
// Bug Condition Tests — Frontend SSE Parser
// ---------------------------------------------------------------------------

describe('Bug Condition Exploration: parseSseLine does not handle Responses API format', () => {
  // -------------------------------------------------------------------------
  // Test 5: Parser should extract delta from response.output_text.delta format
  // -------------------------------------------------------------------------
  it('should return "Hello" for Responses API delta format: data: {"type":"response.output_text.delta","delta":"Hello"}', () => {
    const line = 'data: {"type":"response.output_text.delta","delta":"Hello"}';
    const result = parseSseLine(line);

    // Expected: "Hello" (fixed behavior)
    // Actual on unfixed code: null (parser only understands choices[0].delta.content)
    expect(result).toBe('Hello');
  });

  it('should return multi-word content from Responses API delta format', () => {
    const line = 'data: {"type":"response.output_text.delta","delta":"Hello, world! How are you?"}';
    const result = parseSseLine(line);

    expect(result).toBe('Hello, world! How are you?');
  });

  it('should return empty string delta from Responses API format (valid content)', () => {
    const line = 'data: {"type":"response.output_text.delta","delta":""}';
    const result = parseSseLine(line);

    expect(result).toBe('');
  });

  it('should return null for non-delta Responses API event types (response.created)', () => {
    const line = 'data: {"type":"response.created","response":{"id":"resp_123"}}';
    const result = parseSseLine(line);

    // This should return null regardless — not a delta event
    expect(result).toBeNull();
  });

  it('should return null for response.completed event type', () => {
    const line = 'data: {"type":"response.completed","response":{"id":"resp_123","status":"completed"}}';
    const result = parseSseLine(line);

    expect(result).toBeNull();
  });

  it('should gracefully handle event: prefix lines (return null)', () => {
    const line = 'event: response.output_text.delta';
    const result = parseSseLine(line);

    expect(result).toBeNull();
  });
});
