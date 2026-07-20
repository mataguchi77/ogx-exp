# Implementation Plan: RAG Document Ingestion

## Overview

Implement a RAG document ingestion pipeline for the Node.js/Express backend. The pipeline registers an embedding model at startup, exposes a `POST /api/ingest` endpoint that orchestrates vector store creation, file upload, and file attachment via OGX, and enhances the existing agent endpoint with conditional `file_search` tool inclusion.

## Tasks

- [x] 1. Add new types to `types.ts`
  - [x] 1.1 Add `OgxFileSearchTool`, `IngestRequest`, and `IngestResponse` interfaces
    - Add `OgxFileSearchTool` with `type: "file_search"` and `vector_store_ids: string[]`
    - Add `IngestRequest` with `filePath: string`
    - Add `IngestResponse` with `success`, optional `fileId`, `vectorStoreId`, `filePath`, `error`
    - Update `OgxResponsesRequest.tools` type to `Array<OgxMcpTool | OgxFileSearchTool>`
    - _Requirements: 7.1, 6.1, 6.2, 5.2_

- [x] 2. Implement RAG Config module
  - [x] 2.1 Create `webapp/server/src/ragConfig.ts`
    - Implement `RagConfig` interface with `embeddingModel`, `embeddingDimension`, `vectorStoreName`, `vectorStoreId`
    - Implement `createRagConfig(env?)` factory reading `EMBEDDING_MODEL` (default: `mxbai-embed-large`) and `EMBEDDING_DIMENSION` (default: `1024`)
    - Implement `getVectorStoreId(config)` and `setVectorStoreId(config, id)` functions
    - Export `vectorStoreName` as constant `"rag-documents"`
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [ ]* 2.2 Write property tests for RAG Config
    - **Property 1: RAG config environment variable round-trip**
    - **Property 2: RAG config vectorStoreId mutability**
    - Create `webapp/server/src/__tests__/ragConfig.property.test.ts`
    - Use fast-check with minimum 100 iterations
    - **Validates: Requirements 8.1, 8.2, 8.3**

- [x] 3. Implement OGX Client module
  - [x] 3.1 Create `webapp/server/src/ogxClient.ts` with model registration and vector store creation
    - Implement `OgxClientConfig` interface with `ogxBaseUrl` and optional `fetchFn`
    - Implement `registerEmbeddingModel(config, modelId, providerId)` — POST to `/v1/models`, treat 409 as success
    - Implement `createVectorStore(config, name, embeddingModel, embeddingDimension)` — POST to `/v1/vector_stores`, return `vectorStoreId`
    - All errors throw with `"Failed to ..."` prefix
    - _Requirements: 1.1, 1.3, 2.1, 2.2, 9.1, 9.2, 9.3, 9.4_

  - [x] 3.2 Add file upload, attachment, and polling to `ogxClient.ts`
    - Implement `uploadFile(config, filePath)` — multipart POST to `/v1/files` with `purpose: "assistants"`, return `fileId`
    - Implement `attachFileToVectorStore(config, vectorStoreId, fileId)` — POST to `/v1/vector_stores/{id}/files`
    - Implement `pollFileStatus(config, vectorStoreId, fileId, timeoutMs?)` — GET polling until `completed` or `failed`, default timeout 120s
    - _Requirements: 3.1, 4.1, 4.2, 4.3, 4.4, 9.1, 9.3_

  - [ ]* 3.3 Write property tests for OGX Client
    - **Property 9: File attachment request correctness**
    - **Property 10: Polling terminates on terminal status**
    - Create `webapp/server/src/__tests__/ogxClient.property.test.ts`
    - Use injectable fetch mocks to verify request structure and polling behavior
    - **Validates: Requirements 4.1, 4.2**

- [x] 4. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Modify `agentRouter.ts` for file_search tool support
  - [x] 5.1 Extend `buildOgxPayload` to accept optional `vectorStoreId` parameter
    - Add `vectorStoreId?: string | null` as the fifth parameter
    - When `vectorStoreId` is a non-null non-empty string, append `{ type: "file_search", vector_store_ids: [vectorStoreId] }` to the `tools` array
    - When `vectorStoreId` is null or undefined, do not add `file_search` tool (preserve existing behavior)
    - _Requirements: 7.1, 7.2_

  - [ ]* 5.2 Write property test for file_search conditional inclusion
    - **Property 3: file_search tool conditional inclusion**
    - Create `webapp/server/src/__tests__/agentRouter.rag.property.test.ts`
    - Verify presence/absence of file_search tool based on vectorStoreId value
    - **Validates: Requirements 7.1, 7.2**

- [x] 6. Implement Ingestion Router
  - [x] 6.1 Create `webapp/server/src/ingestRouter.ts`
    - Implement `createIngestRouter(appConfig, ragConfig, fetchFn?)` factory returning an Express Router
    - Validate Content-Type includes `application/json` → 415 if not
    - Validate `filePath` is present, non-empty string → 400 if not
    - Check file exists on disk via `fs.access` → 400 if not found
    - Orchestrate: createVectorStore → setVectorStoreId → uploadFile → attachFileToVectorStore → pollFileStatus
    - Return 200 with `{ success: true, fileId, vectorStoreId, filePath }` on success
    - Map OGX errors to 502, polling timeout to 504, unexpected errors to 500
    - _Requirements: 2.3, 3.1, 3.2, 3.3, 3.4, 4.3, 4.4, 5.1, 5.2, 5.3, 6.1, 6.2_

  - [ ]* 6.2 Write property tests for Ingestion Router
    - **Property 4: Non-JSON Content-Type rejection**
    - **Property 5: Invalid filePath rejection**
    - **Property 6: Non-existent file path rejection**
    - **Property 7: OGX API errors map to HTTP 502**
    - **Property 8: Successful ingestion response structure**
    - Create `webapp/server/src/__tests__/ingestRouter.property.test.ts`
    - Use supertest with mocked OGX client functions
    - **Validates: Requirements 5.1, 5.2, 5.3, 3.2, 2.3, 3.3, 6.1, 6.2**

- [x] 7. Wire everything together in `index.ts`
  - [x] 7.1 Update `webapp/server/src/index.ts` to initialize RAG and mount ingest router
    - Import `createRagConfig` and call it after `loadConfig()`
    - Import `registerEmbeddingModel` from `ogxClient.ts` and call at startup (exit on failure, 409 = success)
    - Import `createIngestRouter` and mount at `/api/ingest`
    - Pass `ragConfig` to `createAgentRouter` so it can read `vectorStoreId` at request time
    - Update `createAgentRouter` call signature to accept `ragConfig` and pass `vectorStoreId` to `buildOgxPayload`
    - _Requirements: 1.1, 1.2, 7.3_

  - [ ]* 7.2 Write unit tests for startup and wiring
    - Test model registration 409 handling (Req 1.3)
    - Test that vectorStoreId changes between requests are reflected (Req 7.3)
    - Test vector store name constant equals `"rag-documents"` (Req 8.4)
    - _Requirements: 1.3, 7.3, 8.4_

- [x] 8. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- The design uses injectable `fetchFn` throughout for testability — follow the existing pattern in `agentRouter.ts` and `tokenManager.ts`
- Property tests use `fast-check` (already a dev dependency) with minimum 100 iterations
- All error messages follow the `"Failed to ..."` prefix convention from AGENTS.md
- Run tests with `npm test` from `webapp/server/`
