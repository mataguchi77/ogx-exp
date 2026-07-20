/**
 * Parses a single SSE line from the OGX streaming response.
 *
 * Supports two formats:
 *
 * 1. Responses API format (preferred):
 *    event: response.output_text.delta
 *    data: {"type":"response.output_text.delta","delta":"Hello"}
 *
 * 2. Chat Completions format (fallback for backward compatibility):
 *    data: {"id":"...","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}
 *    data: [DONE]
 *
 * Returns the delta content string, or null if the line should be skipped.
 */
export function parseSseLine(line: string): string | null {
  // Skip SSE event-type lines (e.g., "event: response.output_text.delta")
  if (line.startsWith('event:')) {
    return null;
  }

  // Only process lines that start with "data: "
  if (!line.startsWith('data: ')) {
    return null;
  }

  const payload = line.slice('data: '.length);

  // [DONE] signals end of stream — caller handles termination separately
  if (payload === '[DONE]') {
    return null;
  }

  // Parse the JSON payload; skip malformed chunks without throwing
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  // --- Responses API format ---
  // {"type":"response.output_text.delta","delta":"Hello"}
  if (obj['type'] === 'response.output_text.delta' && typeof obj['delta'] === 'string') {
    return obj['delta'];
  }

  // Return null for other Responses API event types (response.created, response.completed, etc.)
  if (typeof obj['type'] === 'string' && (obj['type'] as string).startsWith('response.')) {
    return null;
  }

  // --- Chat Completions format (fallback) ---
  // {"choices":[{"delta":{"content":"Hello"}}]}
  if (!Array.isArray(obj['choices']) || (obj['choices'] as unknown[]).length === 0) {
    return null;
  }

  const firstChoice = (obj['choices'] as unknown[])[0];
  if (firstChoice === null || typeof firstChoice !== 'object' || !('delta' in (firstChoice as object))) {
    return null;
  }

  const delta = (firstChoice as Record<string, unknown>)['delta'];
  if (delta === null || typeof delta !== 'object' || !('content' in (delta as object))) {
    return null;
  }

  const content = (delta as Record<string, unknown>)['content'];
  if (typeof content !== 'string') {
    return null;
  }

  return content;
}
