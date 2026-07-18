import { useState, useRef, useCallback } from 'react';
import { parseSseLine } from '../utils/sseParser';
import type { ChatMessage, UseStreamingChatReturn } from '../types';

/**
 * Custom hook that manages all streaming chat state and side effects.
 *
 * Exposes:
 *  - messages: committed conversation history
 *  - streamingBuffer: in-progress assistant reply (null when idle)
 *  - isStreaming: true while a stream is active
 *  - sendMessage: validate, POST, read SSE stream
 *  - stopStreaming: abort and commit partial buffer
 *  - clearConversation: reset message history
 */
export function useStreamingChat(): UseStreamingChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingBuffer, setStreamingBuffer] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);

  // Use a ref so stopStreaming can access the live controller without a stale closure.
  const abortControllerRef = useRef<AbortController | null>(null);
  // Use a ref to track the live buffer value inside the async stream loop,
  // so stopStreaming can commit the latest partial content.
  const bufferRef = useRef<string>('');

  /**
   * Append a new message to the committed message list.
   */
  const appendMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  /**
   * Transition from streaming back to idle state.
   */
  const finishStreaming = useCallback(() => {
    setIsStreaming(false);
    setStreamingBuffer(null);
    abortControllerRef.current = null;
  }, []);

  /**
   * Submit a user message and stream the assistant reply.
   *
   * Requirements: 4.1–4.7, 5.1–5.6, 6.1–6.6, 7.1–7.6, 8.1–8.6
   */
  const sendMessage = useCallback(
    async (text: string): Promise<void> => {
      // Requirement 4.4 — reject blank/whitespace input
      if (text.trim() === '') {
        return;
      }

      // Create and store the AbortController for this request
      const controller = new AbortController();
      abortControllerRef.current = controller;

      // Build the user message
      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
      };

      // Requirement 4.1 — append user message immediately
      // Capture the current messages + the new user message for the request body.
      // We do this via a functional update that also captures the updated list.
      let messagesForRequest: ChatMessage[] = [];
      setMessages((prev) => {
        messagesForRequest = [...prev, userMessage];
        return messagesForRequest;
      });

      // Requirement 4.3 / 6.1 — disable controls while streaming
      setIsStreaming(true);
      setStreamingBuffer('');
      bufferRef.current = '';

      try {
        // Requirement 4.2 / 8.2 — send full history including the new user message
        const response = await fetch('/api/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: messagesForRequest }),
          signal: controller.signal,
        });

        // Requirement 7.1 / 7.2 — handle HTTP error responses
        if (!response.ok) {
          let errorContent: string;

          if (response.status === 429) {
            // Requirement 7.7 — include Request ID for rate limit errors
            try {
              const errorBody = (await response.json()) as {
                error?: string;
                request_id?: string;
              };
              const message = errorBody.error ?? 'Too many requests';
              errorContent = `Too many requests: ${message}`;
            } catch {
              errorContent = 'Too many requests: please wait and retry';
            }
          } else {
            errorContent = `Error: HTTP ${response.status}`;
          }

          appendMessage({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: errorContent,
            isError: true,
          });
          finishStreaming();
          return;
        }

        // Requirement 5.1–5.6 — read the SSE ReadableStream
        const reader = response.body?.getReader();
        if (!reader) {
          appendMessage({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: 'Network error: could not reach backend',
            isError: true,
          });
          finishStreaming();
          return;
        }

        const decoder = new TextDecoder();
        let done = false;
        let receivedDone = false;
        // Accumulate partial lines across chunk boundaries
        let lineRemainder = '';

        while (!done) {
          const { value, done: readerDone } = await reader.read();
          done = readerDone;

          if (value) {
            const chunk = decoder.decode(value, { stream: !done });
            const lines = (lineRemainder + chunk).split('\n');
            // The last element may be an incomplete line — carry it forward
            lineRemainder = lines.pop() ?? '';

            for (const line of lines) {
              const trimmed = line.trimEnd();
              if (trimmed === '') continue;

              // Requirement 5.3 — handle [DONE] signal
              if (trimmed === 'data: [DONE]') {
                receivedDone = true;
                // Commit the buffer as the final assistant message
                const finalContent = bufferRef.current;
                appendMessage({
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  content: finalContent,
                });
                finishStreaming();
                done = true;
                break;
              }

              // Requirement 5.1 / 5.2 / 5.4 — parse delta and append to buffer
              const delta = parseSseLine(trimmed);
              if (delta !== null) {
                bufferRef.current += delta;
                setStreamingBuffer(bufferRef.current);
              }
            }
          }
        }

        // Requirement 5.6 / 7.3 — stream ended without [DONE]
        if (!receivedDone) {
          appendMessage({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: bufferRef.current,
            isIncomplete: true,
          });
          finishStreaming();
        }
      } catch (error) {
        // Aborted by the user via stopStreaming — stopStreaming handles commit
        if (error instanceof Error && error.name === 'AbortError') {
          return;
        }

        // Requirement 7.4 — network error
        appendMessage({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: 'Network error: could not reach backend',
          isError: true,
        });
        finishStreaming();
      }
    },
    [appendMessage, finishStreaming],
  );

  /**
   * Cancel an in-progress stream and commit whatever has accumulated.
   *
   * Requirements: 6.2, 6.3, 6.4
   */
  const stopStreaming = useCallback((): void => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    // Requirement 6.3 — commit partial buffer marked as "(stopped)"
    const partialContent = bufferRef.current;
    appendMessage({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: partialContent + ' (stopped)',
      isStopped: true,
    });

    finishStreaming();
  }, [appendMessage, finishStreaming]);

  /**
   * Reset the conversation without making any network requests.
   *
   * Requirements: 8.3, 8.4
   */
  const clearConversation = useCallback((): void => {
    setMessages([]);
  }, []);

  return {
    messages,
    streamingBuffer,
    isStreaming,
    sendMessage,
    stopStreaming,
    clearConversation,
  };
}
