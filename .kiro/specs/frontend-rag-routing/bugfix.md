# Bugfix Requirements Document

## Introduction

The frontend chat UI sends messages to `/api/chat/stream`, which proxies directly to the OGX Chat Completions endpoint (`/v1/chat/completions`) with `stream: true`. This endpoint does not support tools or vector stores, so users never receive RAG-augmented responses even though the backend has fully configured Ollama RAG with a persisted vector store (e.g. `vs_1ae3f815-...`) loaded at startup. The agent endpoint (`/api/invoke-agent`) already demonstrates the correct pattern by calling the Responses API (`/v1/responses`) with the `file_search` tool and a `vectorStoreId`. The streaming chat must be rerouted through the Responses API to deliver RAG capabilities to the chat UI.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a user sends a message through the frontend chat UI AND a vector store with ingested documents is configured THEN the system returns a plain LLM response without any RAG augmentation because `/api/chat/stream` calls `/v1/chat/completions` which has no tool or vector store support

1.2 WHEN a user sends a message through the frontend chat UI THEN the system never includes the `file_search` tool in the upstream API call because `chatRouter.ts` builds a Chat Completions payload with only `model`, `messages`, and `stream` fields

1.3 WHEN a user asks a question that could be answered by ingested documents THEN the system responds using only the LLM's parametric knowledge, ignoring all indexed content in the vector store

### Expected Behavior (Correct)

2.1 WHEN a user sends a message through the frontend chat UI AND a vector store is configured (vectorStoreId is available) THEN the system SHALL call the OGX Responses API (`/v1/responses`) with `stream: true` and include a `file_search` tool referencing the configured vector store ID, so that responses are RAG-augmented

2.2 WHEN a user sends a message through the frontend chat UI AND no vector store is configured (vectorStoreId is null or empty) THEN the system SHALL call the OGX Responses API (`/v1/responses`) with `stream: true` without the `file_search` tool, providing a plain LLM streaming response

2.3 WHEN the backend streams a response from the Responses API THEN the system SHALL relay the streamed output to the frontend client using Server-Sent Events (SSE), maintaining the existing streaming UX contract

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a user sends a message through the frontend chat UI THEN the system SHALL CONTINUE TO validate the `messages` array (non-empty, max 100 items) and return 400 for invalid input

3.2 WHEN the upstream OGX endpoint returns a non-2xx status THEN the system SHALL CONTINUE TO return an appropriate error response (502 for upstream errors, 429 for rate limiting) to the frontend

3.3 WHEN the client disconnects mid-stream THEN the system SHALL CONTINUE TO abort the upstream request and end the response gracefully without errors

3.4 WHEN the OGX endpoint is unreachable (network error) THEN the system SHALL CONTINUE TO return a 502 error to the frontend

3.5 WHEN the frontend calls `stopStreaming` THEN the system SHALL CONTINUE TO abort the in-progress fetch, commit the partial buffer marked as "(stopped)", and transition to idle state

3.6 WHEN the frontend calls `clearConversation` THEN the system SHALL CONTINUE TO reset all message state without making network requests
