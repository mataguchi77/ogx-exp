# Frontend RAG Routing Bugfix Design

## Overview

The frontend chat streaming endpoint (`/api/chat/stream`) currently proxies requests directly to the OGX Chat Completions API (`/v1/chat/completions`), which does not support tools or vector stores. This means RAG-augmented responses are never delivered to the chat UI, regardless of which RAG source is configured. The fix reroutes the chat stream through the OGX Responses API (`/v1/responses`) with `stream: true`, conditionally includes the appropriate tool based on `RAG_SOURCE`:

- **`RAG_SOURCE=ollama` + vectorStoreId configured** → `file_search` tool with the vectorStoreId
- **`RAG_SOURCE=aws` + valid bearer token** → `mcp` tool with `config.gatewayUrl` and bearer token
- **`RAG_SOURCE=ollama` + no vectorStoreId** → plain response, no tools
- **`RAG_SOURCE=aws` + no valid token** → 503 error (token unavailable)

The frontend SSE parser is also updated to handle the Responses API streaming format (`response.output_text.delta` events instead of `choices[0].delta.content`).

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug — when a user sends a chat message and either a vector store (Ollama RAG) or a valid bearer token (AWS RAG) is available, but the chat endpoint calls Chat Completions instead of the Responses API, so neither `file_search` nor `mcp` tools are ever included
- **Property (P)**: The desired behavior — the chat endpoint SHALL call the Responses API with `stream: true`, include the correct tool (`file_search` or `mcp`) based on `ragConfig.ragSource`, and the frontend SHALL correctly parse the Responses API streaming format
- **Preservation**: Existing validation, error handling, abort/stop streaming, clear conversation, and error response codes must remain unchanged
- **`createChatRouter()`**: The router factory in `webapp/server/src/chatRouter.ts` that currently takes no config params and builds a Chat Completions payload
- **`parseSseLine()`**: The SSE parser in `webapp/client/src/utils/sseParser.ts` that currently only understands Chat Completions format (`choices[0].delta.content`)
- **`useStreamingChat()`**: The React hook in `webapp/client/src/hooks/useStreamingChat.ts` that manages streaming state and looks for `data: [DONE]` to terminate the stream
- **`AppConfig`**: Configuration object providing `gatewayUrl` and `ollamaModel`
- **`TokenManager`**: Service that manages the Cognito OAuth2 token lifecycle; `getToken()` returns the current bearer token or `null` if unavailable
- **`RagConfig`**: Configuration object with `ragSource` (`"ollama" | "aws"`), `vectorStoreId`, and embedding settings
- **`OgxMcpTool`**: Existing type in `types.ts` — `{ type: "mcp", server_url, server_label, authorization }`
- **Responses API streaming format**: SSE events with `event: response.output_text.delta` and `data: {"type":"response.output_text.delta","delta":"..."}`, terminated by `event: response.completed`

## Bug Details

### Bug Condition

The bug manifests when a user sends a message through the frontend chat UI. The `createChatRouter()` function builds a Chat Completions payload (`/v1/chat/completions`) that has no support for tools or vector stores. It takes no configuration parameters, so it has no access to `config`, `tokenManager`, or `ragConfig`. The frontend SSE parser only understands Chat Completions streaming format.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type {
    messages: ChatMessage[],
    ragConfig: RagConfig,
    config: AppConfig,
    tokenManager: TokenManager
  }
  OUTPUT: boolean
  
  RETURN input.messages is a valid non-empty array
         AND (
           (ragConfig.ragSource == "ollama" AND ragConfig.vectorStoreId is not null)
           OR (ragConfig.ragSource == "aws" AND tokenManager.getToken() is not null)
         )
         AND chatRouter calls /v1/chat/completions (no file_search or mcp tool possible)
END FUNCTION
```

Note: Even when `RAG_SOURCE=ollama` and no vectorStoreId is configured, the Responses API should be used unconditionally for consistency, just without any tools.

### Examples

- **Ollama RAG with vectorStoreId**: User sends "What does our architecture document say about providers?" with `RAG_SOURCE=ollama` and `vectorStoreId=vs_1ae3f815-...` → **Expected**: Responses API called with `file_search` tool, RAG-augmented content returned. **Actual**: Chat Completions called, plain LLM response with no document context.
- **AWS RAG with valid token**: User sends "Summarize the knowledge base" with `RAG_SOURCE=aws` and a valid bearer token → **Expected**: Responses API called with `mcp` tool pointing to gateway URL, RAG-augmented content from Bedrock AgentCore returned. **Actual**: Chat Completions called, plain LLM response.
- **Ollama RAG without vectorStoreId**: User sends "Hello" with `RAG_SOURCE=ollama` and no vectorStoreId → **Expected**: Responses API called without any tools, plain streaming response. **Actual**: Chat Completions called; response works but uses wrong API path.
- **AWS RAG without valid token**: User sends "Hello" with `RAG_SOURCE=aws` but `tokenManager.getToken()` returns null → **Expected**: 503 response with "OAuth2 token unavailable" message. **Actual**: Chat Completions called, no token check occurs at all.
- **Frontend format mismatch**: Frontend receives `response.output_text.delta` events → **Expected**: Parser extracts `delta` field and renders it. **Actual**: Parser looks for `choices[0].delta.content` and returns null for every line.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Input validation: messages array must be non-empty and max 100 items, returning 400 for invalid input
- Error handling: 502 for upstream non-2xx, 429 for rate limiting, 502 for network errors
- Client disconnect handling: abort upstream request and end response gracefully
- Frontend `stopStreaming`: abort fetch, commit partial buffer with "(stopped)", transition to idle
- Frontend `clearConversation`: reset all message state without network requests
- HTTP response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`

**Scope:**
All inputs that do NOT involve the streaming data format or API routing should be completely unaffected by this fix. This includes:
- Request validation logic (400 responses for bad input)
- Error proxying behavior (502, 429 responses)
- AbortController/disconnect handling
- Frontend state management (messages, streamingBuffer, isStreaming)
- Stop and clear conversation functionality

## Hypothesized Root Cause

Based on the bug description, the root causes are:

1. **Missing dependencies in chatRouter**: `createChatRouter()` takes no parameters and has no access to `config` (for `gatewayUrl`, `ollamaModel`), `tokenManager` (for bearer token), or `ragConfig` (for `ragSource` and `vectorStoreId`). Without these dependencies, it cannot include any tools or select the correct behavior per RAG source.

2. **Wrong upstream API endpoint**: `chatRouter.ts` calls `/v1/chat/completions` which only supports `model`, `messages`, and `stream`. The Responses API (`/v1/responses`) supports tools including `file_search` and `mcp`.

3. **Wrong payload format**: The Chat Completions payload uses `messages` field directly, while the Responses API expects `input` field with the same message format, plus a `tools` array.

4. **No token validation for AWS path**: The chat router performs no bearer token check. When `RAG_SOURCE=aws` and the token is unavailable, it should return 503 (matching `agentRouter.ts` behavior).

5. **Frontend parser incompatibility**: `parseSseLine()` only handles Chat Completions format (`choices[0].delta.content`). The Responses API uses `{"type":"response.output_text.delta","delta":"..."}` format.

6. **Frontend stream termination mismatch**: `useStreamingChat.ts` checks for `data: [DONE]` to terminate the stream. The Responses API terminates with an `event: response.completed` event.

## Correctness Properties

Property 1: Bug Condition (Ollama RAG) - Chat Stream Uses Responses API with file_search

_For any_ valid chat message request where `ragConfig.ragSource == "ollama"` and a vectorStoreId is configured (non-null, non-empty), the fixed `createChatRouter` SHALL call the OGX Responses API (`/v1/responses`) with `stream: true`, include the `file_search` tool with the configured vectorStoreId, and relay the streamed SSE output to the client.

**Validates: Requirements 2.1, 2.5**

Property 2: Bug Condition (AWS RAG) - Chat Stream Uses Responses API with mcp Tool

_For any_ valid chat message request where `ragConfig.ragSource == "aws"` and `tokenManager.getToken()` returns a valid bearer token, the fixed `createChatRouter` SHALL call the OGX Responses API (`/v1/responses`) with `stream: true`, include an `mcp` tool with `server_url` set to `config.gatewayUrl`, `server_label` set to `"bedrock-agentcore"`, and `authorization` set to the bearer token (prefixed with `"Bearer "`), and relay the streamed SSE output to the client.

**Validates: Requirements 2.2, 2.5**

Property 3: No-Tool Fallback - Plain Responses API Without Tools

_For any_ valid chat message request where `ragConfig.ragSource == "ollama"` and no vectorStoreId is configured (null or empty), the fixed `createChatRouter` SHALL call the OGX Responses API (`/v1/responses`) with `stream: true` and an empty `tools` array, providing a plain LLM streaming response.

**Validates: Requirements 2.3**

Property 4: AWS Token Unavailable - 503 Error

_For any_ valid chat message request where `ragConfig.ragSource == "aws"` and `tokenManager.getToken()` returns null, the fixed `createChatRouter` SHALL return HTTP 503 with an error message indicating the OAuth2 token is unavailable, without making any upstream API call.

**Validates: Requirements 2.4**

Property 5: Preservation - Validation and Error Handling Unchanged

_For any_ input that triggers validation errors (empty messages, too many messages), upstream failures (non-2xx, 429, network errors), or client disconnects, the fixed code SHALL produce the same HTTP status codes and error response structure as the original code, preserving all existing error handling behavior.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `webapp/server/src/chatRouter.ts`

**Function**: `createChatRouter`

**Specific Changes**:
1. **Add dependencies**: Change signature to `createChatRouter(config: AppConfig, tokenManager: TokenManager, ragConfig: RagConfig, fetchFn?: typeof fetch)` — following the same pattern as `createAgentRouter(config, tokenManager, fetchFn, ragConfig)`
2. **Add token check for AWS path**: Before making the upstream call, if `ragConfig.ragSource === 'aws'`, call `tokenManager.getToken()`. If null, return 503 with `"Failed to process request: OAuth2 token unavailable"` (matching agentRouter pattern)
3. **Switch API endpoint**: Change from `${ogxBaseUrl}/v1/chat/completions` to `${config.ogxBaseUrl}/v1/responses` (use `config.ogxBaseUrl` instead of reading `process.env` directly)
4. **Build Responses API payload with tool selection**:
   - Use `config.ollamaModel` for the `model` field (instead of reading `process.env`)
   - Convert `messages` to `input` field format
   - Add `stream: true`
   - If `ragConfig.ragSource === 'aws'`: include `{ type: 'mcp', server_url: config.gatewayUrl, server_label: 'bedrock-agentcore', authorization: bearerToken }` in tools
   - If `ragConfig.ragSource === 'ollama'` AND vectorStoreId is non-null/non-empty: include `{ type: 'file_search', vector_store_ids: [vectorStoreId] }` in tools
   - Otherwise: empty tools array
5. **Preserve all existing validation**: Keep the messages validation (non-empty, max 100) and error handling (429, non-2xx, network errors, abort) unchanged

**File**: `webapp/server/src/index.ts`

**Function**: `main`

**Specific Changes**:
6. **Inject all dependencies**: Change `createChatRouter()` to `createChatRouter(config, tokenManager, ragConfig)` to pass configuration, token manager, and RAG configuration

**File**: `webapp/client/src/utils/sseParser.ts`

**Function**: `parseSseLine`

**Specific Changes**:
7. **Handle Responses API format**: Add parsing for `{"type":"response.output_text.delta","delta":"..."}` payloads in addition to (or replacing) the Chat Completions format
8. **Handle event lines**: The Responses API sends `event:` lines before `data:` lines — ensure these are gracefully skipped or used to identify message type

**File**: `webapp/client/src/hooks/useStreamingChat.ts`

**Function**: `sendMessage`

**Specific Changes**:
9. **Update stream termination**: Replace or augment the `data: [DONE]` check with detection of `response.completed` event type to know when the stream has finished
10. **Handle event: lines**: Parse `event:` prefix lines to detect `response.completed` as the termination signal

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write tests that call `createChatRouter()` with a mock fetch and verify what endpoint URL and payload format it sends upstream. Run these tests on the UNFIXED code to observe that it calls `/v1/chat/completions` and does not include any tools.

**Test Cases**:
1. **Ollama RAG with vectorStoreId test**: Attempt to pass ragConfig with vectorStoreId to createChatRouter and verify it sends `file_search` tool (will fail on unfixed code — no ragConfig param exists)
2. **AWS RAG with valid token test**: Attempt to pass config and tokenManager and verify it sends `mcp` tool (will fail on unfixed code — no config/tokenManager params exist)
3. **AWS RAG token unavailable test**: Verify 503 is returned when tokenManager.getToken() is null (will fail on unfixed code — no token check exists)
4. **Parser format test**: Send a Responses API formatted SSE line through `parseSseLine()` and verify it returns null (will fail — confirms parser doesn't handle new format)
5. **Stream termination test**: Verify `useStreamingChat` does not recognize `response.completed` as stream end (will fail — confirms termination mismatch)

**Expected Counterexamples**:
- `createChatRouter()` always calls `/v1/chat/completions` regardless of RAG configuration
- No `mcp` tool or `file_search` tool is ever included in the upstream request
- `parseSseLine('data: {"type":"response.output_text.delta","delta":"Hello"}')` returns null
- No 503 response for missing bearer token in AWS mode
- Possible causes: wrong API endpoint, missing dependencies, wrong payload format, parser incompatibility

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := createChatRouter_fixed(config, tokenManager, ragConfig)(input)
  ASSERT result.upstreamUrl = "${config.ogxBaseUrl}/v1/responses"
  ASSERT result.payload.stream = true
  IF ragConfig.ragSource == "ollama" AND vectorStoreId != null THEN
    ASSERT result.payload.tools CONTAINS { type: "file_search", vector_store_ids: [vectorStoreId] }
  ELSE IF ragConfig.ragSource == "aws" AND tokenManager.getToken() != null THEN
    ASSERT result.payload.tools CONTAINS { type: "mcp", server_url: config.gatewayUrl, server_label: "bedrock-agentcore", authorization: bearerToken }
  END IF
  ASSERT result.payload.input = convertMessages(input.messages)
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  // Validation errors should produce identical responses
  ASSERT createChatRouter_original()(input).status = createChatRouter_fixed(config, tokenManager, ragConfig)(input).status
  ASSERT createChatRouter_original()(input).body = createChatRouter_fixed(config, tokenManager, ragConfig)(input).body
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain (various invalid message arrays, edge-case lengths)
- It catches edge cases that manual unit tests might miss (e.g., exactly 100 messages, empty strings)
- It provides strong guarantees that validation behavior is unchanged for all error paths

**Test Plan**: Observe behavior on UNFIXED code first for validation and error scenarios, then write property-based tests capturing that behavior.

**Test Cases**:
1. **Validation Preservation**: Verify that empty messages, messages > 100, and non-array messages all return 400 with the same error messages after the fix
2. **Error Response Preservation**: Verify that upstream 502, 429, and network errors produce the same HTTP status and error structure after the fix
3. **Abort Handling Preservation**: Verify that client disconnect still aborts upstream and ends response gracefully
4. **Stop Streaming Preservation**: Verify that stopStreaming still commits partial buffer with "(stopped)" suffix

### Unit Tests

- Test `createChatRouter` builds correct Responses API payload with `file_search` when `ragConfig.ragSource === 'ollama'` and vectorStoreId is present
- Test `createChatRouter` builds correct Responses API payload with `mcp` tool when `ragConfig.ragSource === 'aws'` and token is available
- Test `createChatRouter` returns 503 when `ragConfig.ragSource === 'aws'` and `tokenManager.getToken()` returns null
- Test `createChatRouter` builds Responses API payload without any tools when `ragConfig.ragSource === 'ollama'` and vectorStoreId is null
- Test `createChatRouter` converts `messages` array to `input` field format correctly
- Test `createChatRouter` uses `config.ollamaModel` for the model field
- Test `parseSseLine` extracts delta content from `response.output_text.delta` format
- Test `parseSseLine` returns null for non-delta event types (response.created, response.completed)
- Test stream termination on `response.completed` event

### Property-Based Tests

- Generate random valid message arrays and verify the fixed router always calls `/v1/responses` with correct payload structure (regardless of RAG source)
- Generate random valid message arrays with `ragSource='aws'` and mock token, verify `mcp` tool is always included with correct `server_url`, `server_label`, and `authorization`
- Generate random valid message arrays with `ragSource='ollama'` and random vectorStoreId, verify `file_search` tool is included when vectorStoreId is non-null
- Generate random invalid inputs (empty arrays, oversized arrays, non-arrays) and verify validation responses are identical to the original
- Generate random SSE lines in Responses API format and verify parser correctly extracts delta content or returns null

### Integration Tests

- Test full Ollama RAG streaming flow: send message with vectorStoreId → verify `file_search` tool included → response contains RAG-augmented content
- Test full AWS RAG streaming flow: send message with valid token → verify `mcp` tool included with gateway URL and bearer token → response contains Bedrock AgentCore content
- Test AWS RAG 503 flow: send message with unavailable token → verify 503 response without upstream call
- Test plain streaming flow: send message without vectorStoreId (Ollama mode) → verify no tools → plain LLM response streams correctly
- Test graceful degradation: upstream returns non-2xx → 502 response preserved regardless of RAG source
- Test frontend rendering: both RAG paths produce the same Responses API streaming format → frontend parser handles both identically
