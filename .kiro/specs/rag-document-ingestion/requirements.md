# Requirements Document

## Introduction

This feature adds a RAG (Retrieval-Augmented Generation) document ingestion pipeline to the Node.js backend. The backend exposes a new `/api/ingest` endpoint that orchestrates document ingestion through the OGX server: registering the embedding model, creating a vector store, uploading files, and attaching them for chunking and embedding. Once documents are ingested, users query the RAG system through the existing `/api/invoke-agent` endpoint by configuring the OGX Responses API with a `file_search` tool pointing at the vector store.

## Glossary

- **Backend**: The Node.js/Express server running on port 5000 at `webapp/server/`
- **OGX**: The API server running on port 8321 that implements OpenAI-compatible APIs for inference, files, vector stores, and responses
- **Embedding_Model**: A configurable embedding model running on Ollama (default: `mxbai-embed-large`), used to generate vector embeddings for document chunks. Any free Ollama-compatible embedding model can be used.
- **Vector_Store**: An OGX resource that stores document chunks as vector embeddings for similarity search, backed by sqlite-vec
- **Ingestion_Router**: The Express router handling `POST /api/ingest` requests
- **File_Search_Tool**: An OGX Responses API tool of type `file_search` that searches a vector store during response generation
- **RAG_Config**: A module that holds RAG-specific configuration values (embedding model name, embedding dimension, vector store ID)
- **OGX_Client**: A module encapsulating HTTP calls to OGX APIs (`/v1/models`, `/v1/vector_stores`, `/v1/files`, `/v1/vector_stores/{id}/files`)

## Requirements

### Requirement 1: Embedding Model Registration

**User Story:** As a developer, I want the backend to register the embedding model with OGX once at server startup, so that OGX can generate embeddings without redundant registration calls on every ingestion request.

#### Acceptance Criteria

1. WHEN the backend server starts, THE Backend SHALL register the embedding model by sending a POST request to `{OGX_BASE_URL}/v1/models` with the model identifier sourced from the `EMBEDDING_MODEL` environment variable (default: `mxbai-embed-large`) and provider ID `ollama`
2. IF the OGX model registration request returns an HTTP error status (other than 409 conflict), THEN THE Backend SHALL log the error and exit with a non-zero exit code
3. IF the OGX model registration request returns HTTP 409 (already registered), THE OGX_Client SHALL treat this as success and proceed

### Requirement 2: Vector Store Creation

**User Story:** As a developer, I want the backend to create a vector store in OGX configured with the embedding model, so that uploaded documents can be chunked and embedded automatically.

#### Acceptance Criteria

1. WHEN the ingestion endpoint is called, THE OGX_Client SHALL create a vector store by sending a POST request to `{OGX_BASE_URL}/v1/vector_stores` with the embedding model name and embedding dimension
2. THE OGX_Client SHALL use the vector store name `rag-documents` as the default store name
3. IF the OGX vector store creation request returns an HTTP error status, THEN THE Ingestion_Router SHALL return an HTTP 502 response with an error message prefixed with "Failed to create vector store"

### Requirement 3: File Upload

**User Story:** As a developer, I want to upload local documents to OGX file storage through the ingestion endpoint, so that they can be attached to the vector store for RAG.

#### Acceptance Criteria

1. WHEN a POST request is sent to `/api/ingest` with a `filePath` field containing an absolute path to a local file, THE Ingestion_Router SHALL read the file and upload it to OGX by sending a multipart POST request to `{OGX_BASE_URL}/v1/files` with `purpose` set to `assistants`
2. IF the specified file does not exist on disk, THEN THE Ingestion_Router SHALL return an HTTP 400 response with an error message prefixed with "Failed to ingest document: file not found"
3. IF the OGX file upload request returns an HTTP error status, THEN THE Ingestion_Router SHALL return an HTTP 502 response with an error message prefixed with "Failed to upload file"
4. THE Ingestion_Router SHALL validate that the `filePath` field is present and is a non-empty string before attempting the upload

### Requirement 4: File Attachment to Vector Store

**User Story:** As a developer, I want uploaded files to be automatically attached to the vector store, so that OGX handles chunking and embedding without manual intervention.

#### Acceptance Criteria

1. WHEN a file is successfully uploaded to OGX, THE OGX_Client SHALL attach the file to the vector store by sending a POST request to `{OGX_BASE_URL}/v1/vector_stores/{vector_store_id}/files` with the file ID
2. THE OGX_Client SHALL poll the file attachment status by sending GET requests to `{OGX_BASE_URL}/v1/vector_stores/{vector_store_id}/files/{file_id}` until the status is `completed` or `failed`
3. IF the file attachment status becomes `failed`, THEN THE Ingestion_Router SHALL return an HTTP 502 response with an error message prefixed with "Failed to process document"
4. IF the polling exceeds 120 seconds without reaching a terminal status, THEN THE Ingestion_Router SHALL return an HTTP 504 response with an error message prefixed with "Failed to process document: timeout"

### Requirement 5: Ingestion Endpoint Request Validation

**User Story:** As a developer, I want the ingestion endpoint to validate incoming requests, so that malformed requests are rejected with clear error messages.

#### Acceptance Criteria

1. WHEN a POST request to `/api/ingest` has a Content-Type header that does not include `application/json`, THE Ingestion_Router SHALL return an HTTP 415 response with an error message prefixed with "Failed to process request: unsupported content type"
2. WHEN a POST request to `/api/ingest` is missing the `filePath` field or the field is empty, THE Ingestion_Router SHALL return an HTTP 400 response with an error message prefixed with "Failed to process request: filePath is required"
3. WHEN a POST request to `/api/ingest` contains a `filePath` that is not a string, THE Ingestion_Router SHALL return an HTTP 400 response with an error message prefixed with "Failed to process request: filePath is required"

### Requirement 6: Ingestion Endpoint Success Response

**User Story:** As a developer, I want the ingestion endpoint to return structured information about the ingested document, so that I can confirm the operation succeeded and reference the created resources.

#### Acceptance Criteria

1. WHEN a document is successfully ingested, THE Ingestion_Router SHALL return an HTTP 200 response with a JSON body containing `success` set to `true`, the `fileId` returned by OGX, and the `vectorStoreId` of the vector store
2. THE Ingestion_Router SHALL include the original `filePath` in the success response body

### Requirement 7: RAG Query via Existing Invoke-Agent Endpoint

**User Story:** As a developer, I want to query the RAG system through the existing `/api/invoke-agent` endpoint, so that the LLM can search ingested documents when answering questions.

#### Acceptance Criteria

1. WHEN a vector store has been created by the ingestion flow, THE Backend SHALL include a `file_search` tool with the vector store ID in the OGX Responses API payload sent by the `/api/invoke-agent` endpoint
2. WHILE no vector store has been created, THE Backend SHALL send the OGX Responses API payload without a `file_search` tool, preserving existing behavior
3. THE Backend SHALL read the active vector store ID from the RAG_Config module at request time, so that newly ingested documents are immediately queryable

### Requirement 8: RAG Configuration Module

**User Story:** As a developer, I want RAG configuration values centralized in a single module with environment-driven defaults, so that the embedding model can be swapped to any free Ollama-compatible model without code changes.

#### Acceptance Criteria

1. THE RAG_Config module SHALL export the embedding model identifier sourced from the `EMBEDDING_MODEL` environment variable, with a default value of `mxbai-embed-large`
2. THE RAG_Config module SHALL export the embedding dimension sourced from the `EMBEDDING_DIMENSION` environment variable, with a default value of `1024`
3. THE RAG_Config module SHALL export a mutable vector store ID that is initially `null` and is set after each successful vector store creation
4. THE RAG_Config module SHALL export the vector store name as a constant with value `rag-documents`

### Requirement 9: OGX Client Module

**User Story:** As a developer, I want OGX API interactions encapsulated in a dedicated client module, so that HTTP call logic is reusable and testable independently of Express routing.

#### Acceptance Criteria

1. THE OGX_Client module SHALL export functions for: registering an embedding model, creating a vector store, uploading a file, attaching a file to a vector store, and polling file attachment status
2. THE OGX_Client module SHALL accept the OGX base URL as a parameter, sourced from `AppConfig.ogxBaseUrl`
3. IF any OGX API call returns a non-2xx HTTP status, THEN THE OGX_Client SHALL throw an error with a message prefixed with "Failed to" describing the operation that failed
4. THE OGX_Client module SHALL accept an optional fetch function parameter for testability
