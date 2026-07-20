# Requirements Document

## Introduction

This feature makes the Ollama-based local vector database persistent across server restarts. Currently, the RAG ingestion pipeline creates a new vector store on every ingestion call and holds the vector store ID only in memory (`RagConfig.vectorStoreId`). When the Node.js backend restarts, the ID is lost and previously ingested documents become unreachable — even though the underlying OGX/sqlite-vec storage retains the data on disk.

This feature introduces persistence of the vector store ID so that the backend can reconnect to an existing vector store on startup, reuse it across ingestion calls, and survive restarts without re-ingesting documents.

## Glossary

- **Backend**: The Node.js/Express server running on port 5000 at `webapp/server/`
- **OGX**: The API server running on port 8321 that implements OpenAI-compatible APIs for inference, files, vector stores, and responses
- **Vector_Store**: An OGX resource that stores document chunks as vector embeddings for similarity search, backed by sqlite-vec on disk
- **Vector_Store_ID**: The unique identifier string returned by OGX when a vector store is created (e.g., `vs_abc123`)
- **RAG_Config**: The module at `webapp/server/src/ragConfig.ts` that holds RAG-specific configuration values and mutable runtime state
- **Persistence_File**: A JSON file on the local filesystem that stores the vector store ID between server restarts
- **OGX_Client**: The module at `webapp/server/src/ogxClient.ts` encapsulating HTTP calls to OGX APIs
- **Ingestion_Router**: The Express router at `webapp/server/src/ingestRouter.ts` handling `POST /api/ingest` requests

## Requirements

### Requirement 1: Persist Vector Store ID to Disk

**User Story:** As a developer, I want the vector store ID saved to a file on disk after each successful ingestion, so that the backend can recover the ID after a restart without re-ingesting documents.

#### Acceptance Criteria

1. WHEN a vector store is successfully created or reused during ingestion, THE Backend SHALL write the vector store ID to the Persistence_File as a JSON object containing at minimum the `vectorStoreId` field
2. THE Backend SHALL store the Persistence_File at a configurable path sourced from the `VECTOR_STORE_STATE_PATH` environment variable, with a default value of `webapp/server/.vector-store-state.json`
3. IF writing the Persistence_File fails due to a filesystem error, THEN THE Backend SHALL log the error and continue operation without crashing
4. THE Backend SHALL write the Persistence_File atomically by writing to a temporary file first and then renaming, to prevent corruption from partial writes

### Requirement 2: Restore Vector Store ID on Startup

**User Story:** As a developer, I want the backend to load a previously persisted vector store ID on startup, so that ingested documents survive server restarts without re-ingestion.

#### Acceptance Criteria

1. WHEN the backend server starts, THE Backend SHALL attempt to read the Persistence_File and parse the `vectorStoreId` field from it
2. WHEN a valid `vectorStoreId` is found in the Persistence_File, THE RAG_Config module SHALL set its `vectorStoreId` to the persisted value before any request handling begins
3. IF the Persistence_File does not exist, THEN THE Backend SHALL proceed with `vectorStoreId` set to `null` and log an informational message
4. IF the Persistence_File contains invalid JSON or is missing the `vectorStoreId` field, THEN THE Backend SHALL proceed with `vectorStoreId` set to `null` and log a warning

### Requirement 3: Validate Persisted Vector Store on Startup

**User Story:** As a developer, I want the backend to verify that a persisted vector store still exists in OGX before using it, so that stale or deleted vector stores do not cause runtime errors.

#### Acceptance Criteria

1. WHEN a `vectorStoreId` is loaded from the Persistence_File, THE Backend SHALL verify the vector store exists by sending a GET request to `{OGX_BASE_URL}/v1/vector_stores/{vectorStoreId}`
2. IF the OGX validation request returns HTTP 200, THEN THE Backend SHALL retain the loaded `vectorStoreId` and log a confirmation message
3. IF the OGX validation request returns HTTP 404, THEN THE Backend SHALL set `vectorStoreId` to `null`, delete the stale Persistence_File, and log a warning that the persisted vector store no longer exists
4. IF the OGX validation request fails with a network error or non-404 error status, THEN THE Backend SHALL set `vectorStoreId` to `null` and log a warning, without deleting the Persistence_File

### Requirement 4: Reuse Existing Vector Store During Ingestion

**User Story:** As a developer, I want subsequent ingestion calls to add documents to the existing vector store rather than creating a new one each time, so that all ingested documents are searchable from a single store.

#### Acceptance Criteria

1. WHEN the ingestion endpoint is called and a valid `vectorStoreId` already exists in RAG_Config, THE Ingestion_Router SHALL skip vector store creation and reuse the existing vector store for file attachment
2. WHEN the ingestion endpoint is called and no `vectorStoreId` exists in RAG_Config, THE Ingestion_Router SHALL create a new vector store and persist the ID as per Requirement 1
3. IF a reused vector store returns HTTP 404 during file attachment, THEN THE Ingestion_Router SHALL create a new vector store, persist the new ID, and retry the file attachment once

### Requirement 5: Persistence File Format

**User Story:** As a developer, I want the persistence file to use a well-defined JSON format, so that it is human-readable and extensible for future metadata.

#### Acceptance Criteria

1. THE Backend SHALL write the Persistence_File as a JSON object with the following fields: `vectorStoreId` (string), `embeddingModel` (string), `createdAt` (ISO 8601 timestamp string)
2. THE Backend SHALL include a `version` field set to `1` in the Persistence_File to support future format migrations
3. WHEN reading the Persistence_File, THE Backend SHALL accept any object containing a valid non-empty string `vectorStoreId` field, regardless of other fields present

### Requirement 6: Gitignore the Persistence File

**User Story:** As a developer, I want the persistence file excluded from version control, so that local vector store state does not leak into the repository.

#### Acceptance Criteria

1. THE Backend SHALL ensure the default Persistence_File path pattern (`.vector-store-state.json`) is listed in the project `.gitignore` file

### Requirement 7: OGX Client Vector Store Retrieval

**User Story:** As a developer, I want the OGX Client module to support retrieving a vector store by ID, so that the startup validation can check whether a persisted store still exists.

#### Acceptance Criteria

1. THE OGX_Client module SHALL export a `getVectorStore` function that sends a GET request to `{OGX_BASE_URL}/v1/vector_stores/{vectorStoreId}` and returns the vector store object on success
2. IF the GET request returns HTTP 404, THEN THE `getVectorStore` function SHALL return `null` to indicate the store does not exist
3. IF the GET request returns any other non-2xx HTTP status, THEN THE `getVectorStore` function SHALL throw an error with a message prefixed with "Failed to retrieve vector store"
4. THE `getVectorStore` function SHALL accept an optional fetch function parameter for testability

### Requirement 8: Backward Compatibility

**User Story:** As a developer, I want the persistence feature to be fully backward compatible, so that existing deployments continue to work without configuration changes.

#### Acceptance Criteria

1. WHEN no Persistence_File exists and no `vectorStoreId` is in memory, THE Backend SHALL behave identically to the current implementation by creating a new vector store on the first ingestion call
2. THE Backend SHALL not require any new mandatory environment variables; all new configuration has sensible defaults
3. WHILE the `RAG_SOURCE` environment variable is set to `aws`, THE Backend SHALL skip all persistence file operations and vector store validation

