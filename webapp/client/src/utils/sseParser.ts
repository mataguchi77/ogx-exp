/**
 * Parses a single SSE line from the OGX chat completions stream.
 *
 * Expected format:
 *   data: {"id":"...","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}
 *   data: [DONE]
 *
 * Returns the delta content string, or null if the line should be skipped.
 */
export function parseSseLine(line: string): string | null {
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

  // Extract choices[0].delta.content
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as Record<string, unknown>)['choices']) ||
    (parsed as Record<string, unknown[]>)['choices'].length === 0
  ) {
    return null;
  }

  const choices = (parsed as Record<string, unknown[]>)['choices'];
  const firstChoice = choices[0];

  if (
    firstChoice === null ||
    typeof firstChoice !== 'object' ||
    !('delta' in (firstChoice as object))
  ) {
    return null;
  }

  const delta = (firstChoice as Record<string, unknown>)['delta'];

  if (
    delta === null ||
    typeof delta !== 'object' ||
    !('content' in (delta as object))
  ) {
    return null;
  }

  const content = (delta as Record<string, unknown>)['content'];

  if (typeof content !== 'string') {
    return null;
  }

  return content;
}
