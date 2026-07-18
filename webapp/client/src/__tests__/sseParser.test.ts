import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { parseSseLine } from '../utils/sseParser';

// ─── Unit / Example Tests ────────────────────────────────────────────────────

describe('parseSseLine — unit tests', () => {
  // Lines that don't start with "data: " are skipped
  it('returns null for an empty string', () => {
    expect(parseSseLine('')).toBeNull();
  });

  it('returns null for a plain comment line', () => {
    expect(parseSseLine(': keep-alive')).toBeNull();
  });

  it('returns null for an event: line', () => {
    expect(parseSseLine('event: message')).toBeNull();
  });

  // [DONE] sentinel
  it('returns null for data: [DONE]', () => {
    expect(parseSseLine('data: [DONE]')).toBeNull();
  });

  // Happy path
  it('extracts delta content from a well-formed chunk', () => {
    const line =
      'data: {"id":"1","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}';
    expect(parseSseLine(line)).toBe('Hello');
  });

  it('extracts an empty string delta (valid content)', () => {
    const line =
      'data: {"id":"1","choices":[{"delta":{"content":""},"finish_reason":null}]}';
    expect(parseSseLine(line)).toBe('');
  });

  // Absent / null delta.content
  it('returns null when delta.content is null', () => {
    const line =
      'data: {"id":"1","choices":[{"delta":{"content":null},"finish_reason":"stop"}]}';
    expect(parseSseLine(line)).toBeNull();
  });

  it('returns null when delta has no content key', () => {
    const line =
      'data: {"id":"1","choices":[{"delta":{},"finish_reason":null}]}';
    expect(parseSseLine(line)).toBeNull();
  });

  it('returns null when delta is absent from the choice', () => {
    const line =
      'data: {"id":"1","choices":[{"finish_reason":"stop"}]}';
    expect(parseSseLine(line)).toBeNull();
  });

  it('returns null when choices is an empty array', () => {
    const line = 'data: {"id":"1","choices":[]}';
    expect(parseSseLine(line)).toBeNull();
  });

  it('returns null when delta.content is a number (not a string)', () => {
    const line =
      'data: {"id":"1","choices":[{"delta":{"content":42},"finish_reason":null}]}';
    expect(parseSseLine(line)).toBeNull();
  });

  // Malformed JSON
  it('returns null for malformed JSON without throwing', () => {
    expect(() => parseSseLine('data: {not json}')).not.toThrow();
    expect(parseSseLine('data: {not json}')).toBeNull();
  });

  it('returns null for data: with a bare string', () => {
    expect(parseSseLine('data: just a string')).toBeNull();
  });

  it('returns null for data: with a JSON array at top level', () => {
    expect(parseSseLine('data: [1, 2, 3]')).toBeNull();
  });
});

// ─── Property-Based Tests ─────────────────────────────────────────────────────

describe('parseSseLine — property-based tests', () => {
  // Feature: frontend-streaming-app, Property 4: Malformed SSE chunks do not corrupt the buffer
  // **Validates: Requirements 5.4**
  it('never throws for any data: prefixed string', () => {
    fc.assert(
      fc.property(fc.string(), (payload) => {
        const line = `data: ${payload}`;
        expect(() => parseSseLine(line)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('returns null for malformed JSON in data: lines', () => {
    // Generate strings that are NOT valid JSON objects with the right shape
    const notJsonArb = fc.string().filter((s) => {
      try {
        JSON.parse(s);
        return false; // valid JSON — exclude from this test
      } catch {
        return true; // malformed JSON — include
      }
    });

    fc.assert(
      fc.property(notJsonArb, (payload) => {
        const result = parseSseLine(`data: ${payload}`);
        expect(result).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  // Feature: frontend-streaming-app, Property 3 (partial): valid delta content is returned verbatim
  // **Validates: Requirements 5.2**
  it('returns the exact delta content string for well-formed chunks', () => {
    const contentArb = fc.string(); // any string is valid content

    fc.assert(
      fc.property(contentArb, (content) => {
        const payload = JSON.stringify({
          id: 'test',
          choices: [{ delta: { content }, finish_reason: null }],
        });
        const result = parseSseLine(`data: ${payload}`);
        expect(result).toBe(content);
      }),
      { numRuns: 100 },
    );
  });

  it('returns null for any line that does not start with "data: "', () => {
    // Generate strings that don't start with "data: "
    const nonDataLineArb = fc.string().filter((s) => !s.startsWith('data: '));

    fc.assert(
      fc.property(nonDataLineArb, (line) => {
        expect(parseSseLine(line)).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});
