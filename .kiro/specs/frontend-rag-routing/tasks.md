# Implementation Plan

## Overview

Fix the frontend chat streaming endpoint to use the OGX Responses API (`/v1/responses`) instead of Chat Completions (`/v1/chat/completions`), enabling RAG-augmented responses via BOTH RAG sources:
- **Ollama RAG** (`RAG_SOURCE=ollama`): includes `file_search` tool when a vector store is configured
- **AWS RAG** (`RAG_SOURCE=aws`): includes `mcp` tool with Bedrock AgentCore gateway URL and bearer token

Update `createChatRouter` to accept `config`, `tokenManager`, and `ragConfig` dependencies. Update the frontend SSE parser and stream termination logic to handle the Responses API streaming format.

## Tasks

- [ ] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Chat Router Uses Chat Completions Instead of Responses API (Both RAG Sources)
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists for both Ollama and AWS RAG paths
  - **Scoped PBT Approach**: Scope the property to concrete failing cases for each RAG source
  - Test Ollama RAG bug condition: call `createChatRouter()` with a mock fetch, send a valid messages array with `ragConfig.ragSource === 'ollama'` and a vectorStoreId, assert the upstream URL is `/v1/responses` (not `/v1/chat/completions`), assert payload contains `tools: [{ type: 'file_search', vector_store_ids: [vectorStoreId] }]`, assert payload uses `input` field (not `messages`), and assert `stream: true`
  - Test AWS RAG bug condition: call `createChatRouter()` with `ragConfig.ragSource === 'aws'` and `tokenManager.getToken()` returning a valid token, assert the upstream URL is `/v1/responses`, assert payload contains `tools: [{ type: 'mcp', server_url: config.gatewayUrl, server_label: 'bedrock-agentcore', authorization: bearerToken }]`
  - Test AWS RAG token unavailable: call `createChatRouter()` with `ragConfig.ragSource === 'aws'` and `tokenManager.getToken()` returning null, assert 503 is returned with `"OAuth2 token unavailable"` message
  - Test no-tool fallback: call `createChatRouter()` with `ragConfig.ragSource === 'ollama'` and no vectorStoreId, assert the upstream URL is `/v1/responses` with empty tools array
  - Test frontend parser bug condition: call `parseSseLine('data: {"type":"response.output_text.delta","delta":"Hello"}')` and assert it returns `"Hello"` (currently returns null)
  - Test frontend stream termination: verify that the stream processing recognizes `response.completed` as the termination signal (currently only recognizes `data: [DONE]`)
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests FAIL (this is correct - it proves the bug exists: router calls wrong endpoint for all RAG paths, no mcp/file_search tools possible, no 503 for missing token, parser doesn't understand Responses API format, stream termination uses wrong signal)
  - Document counterexamples found: `createChatRouter()` takes no config/tokenManager/ragConfig params, always calls `/v1/chat/completions`, `parseSseLine` returns null for Responses API format, no token check exists, stream never terminates on `response.completed`
  - Mark task complete when tests are written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [ ] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Validation, Error Handling, and Client Controls Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - Observe on UNFIXED code: empty messages array returns 400 with `"messages array is required and must not be empty"`
  - Observe on UNFIXED code: messages array with >100 items returns 400 with `"messages array must not exceed 100 items"`
  - Observe on UNFIXED code: upstream 429 response returns 429 with `"Too many requests: ..."` error
  - Observe on UNFIXED code: upstream non-2xx (e.g. 500) returns 502 with `"Failed to proxy stream: upstream returned 500"`
  - Observe on UNFIXED code: network error (TypeError from fetch) returns 502 with `"Failed to proxy stream: OGX endpoint unreachable"`
  - Observe on UNFIXED code: client disconnect aborts upstream and ends response gracefully
  - Observe on UNFIXED code: `stopStreaming()` aborts fetch, commits partial buffer with "(stopped)", transitions to idle
  - Observe on UNFIXED code: `clearConversation()` resets messages without network requests
  - Write property-based tests: for all invalid message arrays (empty, >100 items, non-array), the router returns the same 400 status and error message structure
  - Write property-based tests: for all upstream error responses (429, 5xx, network errors), the router returns the same HTTP status codes and error payloads
  - Write property-based tests: for client disconnect scenarios, abort behavior is preserved
  - Verify all preservation tests pass on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [ ] 3. Fix for chat stream not using Responses API with dual RAG source support

  - [ ] 3.1 Update `createChatRouter` signature and dependencies in `webapp/server/src/chatRouter.ts`
    - Change signature to `createChatRouter(config: AppConfig, tokenManager: TokenManager, ragConfig: RagConfig, fetchFn?: typeof fetch)`
    - Import `AppConfig`, `OgxMcpTool`, `OgxFileSearchTool` from `./types.js`
    - Import `TokenManager` from `./tokenManager.js`
    - Import `RagConfig` and `getVectorStoreId` from `./ragConfig.js`
    - Use `config.ogxBaseUrl` instead of reading `process.env.OGX_BASE_URL`
    - Use `config.ollamaModel` instead of reading `process.env.OLLAMA_MODEL`
    - _Bug_Condition: createChatRouter() takes no config/tokenManager/ragConfig params, cannot route by RAG source_
    - _Expected_Behavior: createChatRouter(config, tokenManager, ragConfig) has all deps for dual RAG routing_
    - _Preservation: Function signature change, no behavior change yet_
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [ ] 3.2 Add AWS token validation in `webapp/server/src/chatRouter.ts`
    - Before making the upstream call, check `ragConfig.ragSource`
    - If `ragConfig.ragSource === 'aws'`, call `tokenManager.getToken()`
    - If token is null, return 503 with `{ error: 'Failed to process request: OAuth2 token unavailable' }` (matching agentRouter pattern)
    - This check MUST occur after messages validation but before the upstream fetch
    - _Bug_Condition: No token check exists for AWS path — chat proceeds without authentication_
    - _Expected_Behavior: 503 returned when ragSource is 'aws' and token is unavailable_
    - _Preservation: Token check only applies to AWS path; Ollama path unaffected_
    - _Requirements: 2.4_

  - [ ] 3.3 Switch to Responses API endpoint and build payload with tool selection in `webapp/server/src/chatRouter.ts`
    - Change upstream URL from `${ogxBaseUrl}/v1/chat/completions` to `${config.ogxBaseUrl}/v1/responses`
    - Build Responses API payload: `{ model: config.ollamaModel, input: messages, tools: [...], stream: true }`
    - Tool selection logic:
      - If `ragConfig.ragSource === 'aws'` AND token is valid: include `{ type: 'mcp', server_url: config.gatewayUrl, server_label: 'bedrock-agentcore', authorization: bearerToken }` in tools
      - If `ragConfig.ragSource === 'ollama'` AND `getVectorStoreId(ragConfig)` is non-null/non-empty: include `{ type: 'file_search', vector_store_ids: [vectorStoreId] }` in tools
      - If `ragConfig.ragSource === 'ollama'` AND no vectorStoreId: empty tools array (plain response)
    - Use `input` field (instead of `messages`) to match `OgxResponsesRequest` type
    - Reference `buildOgxPayload()` in `agentRouter.ts` as the correct pattern for both tool types
    - Preserve all existing validation logic (empty messages → 400, >100 messages → 400)
    - Preserve all existing error handling (429 → 429, non-2xx → 502, TypeError → 502, AbortError → graceful end)
    - Preserve SSE headers and raw byte piping behavior
    - _Bug_Condition: chatRouter calls /v1/chat/completions with no tools support for either RAG source_
    - _Expected_Behavior: chatRouter calls /v1/responses with stream:true, includes mcp tool (AWS) or file_search tool (Ollama) or no tools (Ollama without vectorStoreId)_
    - _Preservation: Validation (400), error responses (429, 502), abort handling, SSE headers unchanged_
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 3.1, 3.2, 3.3, 3.4_

  - [ ] 3.4 Update `main` in `webapp/server/src/index.ts` to pass all dependencies to chatRouter
    - Change `createChatRouter()` to `createChatRouter(config, tokenManager, ragConfig)`
    - Always pass all three deps — ragConfig is always created regardless of ragSource
    - This ensures the chat router can handle both AWS and Ollama RAG paths dynamically
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [ ] 3.5 Update `parseSseLine` in `webapp/client/src/utils/sseParser.ts` to handle Responses API format
    - Add parsing for `{"type":"response.output_text.delta","delta":"..."}` JSON payloads
    - When parsed JSON has `type === "response.output_text.delta"` and a string `delta` field, return the `delta` value
    - Skip `event:` prefix lines gracefully (return null for lines starting with `event:`)
    - Keep existing Chat Completions format parsing as fallback for backward compatibility
    - Return null for non-delta event types (`response.created`, `response.completed`, `response.output_item.added`, etc.)
    - _Requirements: 2.5_

  - [ ] 3.6 Update `sendMessage` in `webapp/client/src/hooks/useStreamingChat.ts` to handle Responses API stream termination
    - Replace `data: [DONE]` termination check with detection of `response.completed` event type
    - Handle `event:` prefix lines in the stream processing loop: when a line starts with `event:`, extract the event type and check if it equals `response.completed`
    - When `response.completed` is detected, commit the buffer as the final assistant message and finish streaming (same behavior as current `[DONE]` handling)
    - Keep `data: [DONE]` as a fallback termination signal for backward compatibility
    - Handle the SSE format where `event:` and `data:` lines come in pairs
    - _Requirements: 2.5, 3.5_

  - [ ] 3.7 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Chat Router Uses Responses API with Dual RAG Source Support
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior:
      - Ollama RAG: router calls `/v1/responses` with `file_search` tool when vectorStoreId is present
      - AWS RAG: router calls `/v1/responses` with `mcp` tool when token is available
      - AWS RAG token unavailable: 503 returned
      - No-tool fallback: router calls `/v1/responses` with empty tools when no vectorStoreId (Ollama)
      - Parser extracts delta from Responses API format
      - Stream terminates on `response.completed`
    - When this test passes, it confirms the expected behavior is satisfied for all RAG paths
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed for both RAG sources)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [ ] 3.8 Verify preservation tests still pass
    - **Property 2: Preservation** - Validation, Error Handling, and Client Controls Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all validation (400), error handling (429, 502), abort behavior, stop streaming, and clear conversation still work identically after the fix
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [ ] 4. Checkpoint - Ensure all tests pass
  - Run full test suite for both server and client packages
  - Ensure bug condition exploration test passes (confirms fix works for both Ollama and AWS RAG)
  - Ensure preservation property tests pass (confirms no regressions)
  - Ensure any existing tests in the webapp still pass
  - Ask the user if questions arise

## Notes

- The `OgxResponsesRequest`, `OgxMcpTool`, and `OgxFileSearchTool` types already exist in `webapp/server/src/types.ts`
- The `getVectorStoreId(ragConfig)` helper already exists in `webapp/server/src/ragConfig.ts`
- The `TokenManager` class already exists in `webapp/server/src/tokenManager.ts`
- The `agentRouter.ts` `buildOgxPayload()` demonstrates the correct Responses API call pattern for BOTH tool types (use as reference implementation)
- `createChatRouter(config, tokenManager, ragConfig)` follows the same dependency injection pattern as `createAgentRouter(config, tokenManager, fetchFn, ragConfig)`
- `ragConfig` is always created in `index.ts` regardless of `ragSource`, so always pass it to chatRouter
- Responses API SSE format: `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n`
- Stream terminates with: `event: response.completed\ndata: {"type":"response.completed","response":{...}}\n\n`
- Keep Chat Completions format parsing as fallback in `parseSseLine` for backward compatibility
- Test files should be placed alongside source files following the existing project conventions

## Correctness Properties Summary

| Property | Type | Title | Validates |
|----------|------|-------|-----------|
| 1 | Bug Condition | Ollama RAG file_search inclusion | Req 2.1, 2.5 |
| 2 | Bug Condition | AWS RAG mcp tool inclusion | Req 2.2, 2.5 |
| 3 | Bug Condition | No-tool fallback (Ollama without vectorStoreId) | Req 2.3 |
| 4 | Bug Condition | 503 for AWS with unavailable token | Req 2.4 |
| 5 | Preservation | Validation and error handling unchanged | Req 3.1–3.6 |

## Task Dependency Graph

```json
{
  "waves": [
    ["1", "2"],
    ["3.1"],
    ["3.2", "3.3"],
    ["3.4"],
    ["3.5", "3.6"],
    ["3.7", "3.8"],
    ["4"]
  ]
}
```
