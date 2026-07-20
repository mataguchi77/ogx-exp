# Implementation Plan: Endpoint Selection

## Overview

Add an `endpoint` parameter to `POST /api/invoke-agent` that routes requests to either AWS Bedrock (with MCP tool) or local Ollama (without MCP tool). Changes are confined to `types.ts` and `agentRouter.ts`, with new property tests in `endpointSelection.property.test.ts`.

## Tasks

- [x] 1. Add EndpointType and update InvokeAgentRequest interface
  - [x] 1.1 Add `EndpointType` type alias and update `InvokeAgentRequest` in `types.ts`
    - Add `export type EndpointType = "aws" | "ollama";`
    - Add optional `endpoint?: EndpointType` field to `InvokeAgentRequest`
    - _Requirements: 1.1_

  - [x] 1.2 Update `buildOgxPayload` signature and implementation in `agentRouter.ts`
    - Change signature to accept `endpoint: EndpointType` parameter (after `config`, before `sessionId`)
    - Change `bearerToken` parameter type from `string` to `string | null`
    - Conditionally include MCP tool only when `endpoint === "aws"`
    - Keep file_search tool logic unchanged (endpoint-independent)
    - _Requirements: 2.1, 3.1, 2.4, 3.4_

  - [x] 1.3 Add endpoint validation and conditional token check in route handler
    - Parse and validate `endpoint` field from request body (default to `"aws"` when omitted/empty)
    - Return HTTP 400 for invalid endpoint values with message "Failed to process request: invalid endpoint value"
    - Make token check conditional: only call `tokenManager.getToken()` when `endpoint === "aws"`
    - Pass `endpoint` to `buildOgxPayload`
    - _Requirements: 1.2, 1.3, 1.4, 2.3, 3.3_

  - [x] 1.4 Update error responses to include endpoint identifier
    - Change OGX error message format to `Failed to invoke agent [${endpoint}]: ${statusText}`
    - Update network error (502) and timeout (504) messages similarly
    - Ensure no internal URLs or credentials appear in error messages
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [x] 2. Update existing tests for new `buildOgxPayload` signature
  - [x] 2.1 Update `agentRouter.property.test.ts` to pass `endpoint` parameter
    - Update all `buildOgxPayload` calls to include `"aws"` as the endpoint parameter
    - Update `bearerToken` type expectations where needed
    - Verify all existing property tests still pass with the new signature
    - _Requirements: 2.1_

- [x] 3. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Write property-based tests for endpoint selection
  - [ ]* 4.1 Write property test: Invalid endpoint values are rejected
    - **Property 1: Invalid endpoint values are rejected**
    - Generate arbitrary strings that are not "aws" or "ollama" (and not empty/undefined)
    - Assert HTTP 400 with `success: false` and error containing "invalid endpoint"
    - **Validates: Requirements 1.3**

  - [ ]* 4.2 Write property test: AWS endpoint includes MCP tool
    - **Property 2: AWS endpoint includes MCP tool with correct configuration**
    - For any valid query with `endpoint: "aws"` and valid token, assert payload contains MCP tool with correct `server_url` and `authorization`
    - **Validates: Requirements 2.1, 1.4**

  - [ ]* 4.3 Write property test: Ollama endpoint excludes MCP tool
    - **Property 3: Ollama endpoint excludes MCP tool**
    - For any valid query with `endpoint: "ollama"`, assert payload contains no tool with `type: "mcp"`
    - **Validates: Requirements 3.1**

  - [ ]* 4.4 Write property test: Omitted endpoint defaults to AWS
    - **Property 4: Omitted endpoint defaults to AWS behavior**
    - For any valid query where endpoint is omitted or empty string, assert payload is identical to `endpoint: "aws"` (includes MCP tool)
    - **Validates: Requirements 1.2**

  - [ ]* 4.5 Write property test: Ollama endpoint skips token validation
    - **Property 5: Ollama endpoint skips token validation**
    - For any valid query with `endpoint: "ollama"` and null token, assert request proceeds (not 503)
    - **Validates: Requirements 3.3**

  - [ ]* 4.6 Write property test: Model field always matches config
    - **Property 6: Model field always matches config**
    - For any endpoint value and any `ollamaModel` config value, assert payload `model` field equals `config.ollamaModel`
    - **Validates: Requirements 2.2, 3.2**

  - [ ]* 4.7 Write property test: Vector store inclusion is endpoint-independent
    - **Property 7: Vector store inclusion is endpoint-independent**
    - For any endpoint value and any non-empty vector store ID, assert payload contains `file_search` tool with that ID
    - **Validates: Requirements 2.4, 3.4**

  - [ ]* 4.8 Write property test: Error responses include endpoint identifier without secrets
    - **Property 8: Error responses include endpoint identifier without exposing secrets**
    - For any endpoint value and OGX error, assert error body contains endpoint identifier and does not contain `config.gatewayUrl`, `config.cognitoTokenUrl`, or bearer token
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4**

- [x] 5. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Only two source files change: `webapp/server/src/types.ts` and `webapp/server/src/agentRouter.ts`
- Property tests go in new file: `webapp/server/src/__tests__/endpointSelection.property.test.ts`
- Existing tests in `agentRouter.property.test.ts` need signature updates but logic stays the same
- The design uses `fast-check` with `vitest` (already in devDependencies)
