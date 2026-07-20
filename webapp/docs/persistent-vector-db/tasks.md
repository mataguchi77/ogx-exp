# Implementation Plan: Persistent Vector Store State

## Overview

Implement persistence of the vector store ID so the backend can reconnect to an existing OGX vector store on startup, reuse it across ingestion calls, and survive restarts without re-ingesting documents. This involves a new persistence module with atomic writes, a new `getVectorStore` OGX client function, modifications to the ingestion router for reuse logic, and a startup validation flow.

## Tasks

- [x] 1. Create the Vector Store State persistence module
  - [x] 1.1 Create `webapp/server/src/vectorStoreState.ts` with interfaces and config
    - Define `VectorStoreStateData` interface with `version`, `vectorStoreId`, `embeddingModel`, `createdAt`
    - Define `PersistenceConfig` interface with `statePath`
    - Implement `createPersistenceConfig(env?)` reading `VECTOR_STORE_STATE_PATH` env var with default `webapp/server/.vector-store-state.json`
    - _Requirements: 1.2, 5.1, 5.2, 8.2_

  - [x] 1.2 Implement `loadVectorStoreState` function
    - Read the state file from disk, parse JSON
    - Return `null` if file doesn't exist (log info), is invalid JSON (log warning), or is missing a non-empty string `vectorStoreId` (log warning)
    - Never throw — catch all errors and return `null`
    - Accept any object with a valid `vectorStoreId` regardless of other fields
    - _Requirements: 2.1, 2.3, 2.4, 5.3_

  - [x] 1.3 Implement `saveVectorStoreState` function with atomic writes
    - Write JSON with `version: 1`, `vectorStoreId`, `embeddingModel`, `createdAt` fields
    - Write to a `.tmp` sibling file first, then rename to target path (atomic write)
    - Never throw — log errors and return silently on failure
    - _Requirements: 1.1, 1.3, 1.4, 5.1, 5.2_

  - [x] 1.4 Implement `deleteStateFile` function
    - Delete the state file at the given path
    - Never throw — log errors and return silently on failure
    - _Requirements: 3.3_

  - [ ]* 1.5 Write property tests for Vector Store State module
    - **Property 1: Persistence round-trip**
    - **Property 2: Configurable state file path**
    - **Property 3: Write errors are non-fatal**
    - **Property 4: Load tolerates malformed input**
    - **Property 5: Load tolerates extra fields**
    - Create `webapp/server/src/__tests__/vectorStoreState.property.test.ts`
    - Use fast-check with minimum 100 iterations
    - **Validates: Requirements 1.1, 1.2, 1.3, 2.1, 2.4, 5.1, 5.2, 5.3, 8.2**

- [x] 2. Add `getVectorStore` function to OGX Client
  - [x] 2.1 Implement `getVectorStore` in `webapp/server/src/ogxClient.ts`
    - Add `VectorStoreObject` interface with `id`, `name`, `status`, and index signature for extra fields
    - Implement `getVectorStore(config, vectorStoreId)` sending GET to `/v1/vector_stores/{vectorStoreId}`
    - Return the vector store object on HTTP 200
    - Return `null` on HTTP 404
    - Throw `Error("Failed to retrieve vector store: HTTP {status}")` on any other non-2xx status
    - Accept optional `fetchFn` parameter via `OgxClientConfig` for testability
    - _Requirements: 3.1, 7.1, 7.2, 7.3, 7.4_

  - [ ]* 2.2 Write property tests for `getVectorStore`
    - **Property 6: getVectorStore returns store object on HTTP 200**
    - **Property 7: getVectorStore returns null on HTTP 404**
    - **Property 8: getVectorStore throws on non-2xx non-404 status**
    - Create `webapp/server/src/__tests__/ogxClient.getVectorStore.property.test.ts`
    - Use injectable fetch mocks to verify behavior across HTTP status codes
    - **Validates: Requirements 3.1, 3.3, 3.4, 7.1, 7.2, 7.3**

- [x] 3. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Modify Ingestion Router for vector store reuse
  - [x] 4.1 Update `createIngestRouter` signature to accept `PersistenceConfig`
    - Add optional `persistenceConfig?: PersistenceConfig` parameter to `createIngestRouter`
    - Import `saveVectorStoreState` and `VectorStoreStateData` from `vectorStoreState.ts`
    - _Requirements: 4.1, 4.2_

  - [x] 4.2 Implement vector store reuse logic in the ingestion route handler
    - When `ragConfig.vectorStoreId` is non-null, skip `createVectorStore` and use existing ID for file attachment
    - When `ragConfig.vectorStoreId` is null, create a new vector store (existing behavior)
    - After creating a new vector store, call `saveVectorStoreState` with the new ID, embedding model, and ISO 8601 timestamp
    - _Requirements: 4.1, 4.2, 1.1_

  - [x] 4.3 Implement retry-on-404 logic for stale vector stores
    - If `attachFileToVectorStore` throws with a 404 error when reusing a store, create a new vector store
    - Persist the new vector store ID via `saveVectorStoreState`
    - Update `ragConfig.vectorStoreId` with the new ID
    - Retry the file attachment once with the new store
    - _Requirements: 4.3_

  - [x] 4.4 Skip persistence operations when `RAG_SOURCE=aws`
    - When `RAG_SOURCE` is set to `aws`, do not read/write/delete the persistence file
    - Do not pass `persistenceConfig` to the ingest router when using AWS RAG source
    - _Requirements: 8.3_

  - [ ]* 4.5 Write property test for ingestion reuse
    - **Property 9: Ingestion reuses existing vector store**
    - Create `webapp/server/src/__tests__/ingestRouter.reuse.property.test.ts`
    - Mock OGX client functions, verify `createVectorStore` is NOT called when `vectorStoreId` exists
    - **Validates: Requirements 4.1**

  - [ ]* 4.6 Write unit tests for retry-on-404 and AWS skip behavior
    - Test attachment 404 triggers new store creation and retry
    - Test no persistence operations occur when `RAG_SOURCE=aws`
    - Test backward compatibility: no state file means first ingestion creates new store
    - **Validates: Requirements 4.3, 8.1, 8.3**

- [x] 5. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement startup validation flow in `index.ts`
  - [x] 6.1 Add startup validation logic to `webapp/server/src/index.ts`
    - Import `createPersistenceConfig`, `loadVectorStoreState`, `deleteStateFile` from `vectorStoreState.ts`
    - Import `getVectorStore` from `ogxClient.ts`
    - After `createRagConfig()` and when using Ollama RAG (not AWS), load persisted state
    - If state exists, validate via `getVectorStore`:
      - HTTP 200: set `ragConfig.vectorStoreId`, log confirmation
      - 404 (null return): delete state file, log warning
      - Network/other error: log warning, proceed with null (do NOT delete file)
    - If no state file exists, proceed with `vectorStoreId = null` and log info
    - Pass `persistenceConfig` to `createIngestRouter`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 8.1, 8.3_

  - [ ]* 6.2 Write unit tests for startup validation
    - Test: valid state + GET 200 → vectorStoreId is set
    - Test: valid state + GET 404 → state file deleted, vectorStoreId is null
    - Test: valid state + network error → file kept, vectorStoreId is null
    - Test: no state file → vectorStoreId is null, info logged
    - Test: invalid JSON in state file → vectorStoreId is null, warning logged
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4**

- [x] 7. Update `.gitignore` for persistence file
  - [x] 7.1 Add `.vector-store-state.json` to the project `.gitignore`
    - Add comment and pattern: `.vector-store-state.json`
    - _Requirements: 6.1_

- [x] 8. Wire AWS backward compatibility check
  - [x] 8.1 Ensure persistence is fully skipped when `RAG_SOURCE=aws`
    - Verify that `createPersistenceConfig` is not called when `RAG_SOURCE=aws`
    - Verify that `loadVectorStoreState` is not called when `RAG_SOURCE=aws`
    - Verify that `createIngestRouter` receives no `persistenceConfig` when `RAG_SOURCE=aws`
    - _Requirements: 8.3_

  - [ ]* 8.2 Write property test for AWS RAG source skip
    - **Property 10: AWS RAG source skips persistence**
    - Verify no persistence file operations occur when `RAG_SOURCE=aws`
    - **Validates: Requirements 8.3**

- [x] 9. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- The persistence module uses atomic writes (write-to-temp + rename) to prevent corruption
- All persistence failures are non-fatal — the server logs and continues
- The `getVectorStore` function follows the existing injectable `fetchFn` pattern
- Property tests use `fast-check` (already a dev dependency) with minimum 100 iterations
- All error messages follow the `"Failed to ..."` prefix convention from AGENTS.md
- Run tests with `npm test` from `webapp/server/`
- Checkpoints ensure incremental validation between major implementation phases
