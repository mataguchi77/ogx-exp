// ---------------------------------------------------------------------------
// OGX Client — encapsulates HTTP interactions with the OGX server.
// Each function accepts an OgxClientConfig with an injectable fetchFn
// for testability, following the pattern in tokenManager.ts / agentRouter.ts.
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';

export interface OgxClientConfig {
  ogxBaseUrl: string;
  fetchFn?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Model registration
// ---------------------------------------------------------------------------

/**
 * Registers an embedding model with OGX.
 * HTTP 409 (already registered) is treated as success.
 * Throws on any other non-2xx response.
 */
export async function registerEmbeddingModel(
  config: OgxClientConfig,
  modelId: string,
  providerId: string
): Promise<void> {
  const doFetch = config.fetchFn ?? globalThis.fetch;

  const response = await doFetch(`${config.ogxBaseUrl}/v1/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model_id: modelId,
      provider_id: providerId,
      model_type: 'embedding',
    }),
  });

  // 409 = already registered → treat as success
  if (response.status === 409) {
    return;
  }

  if (!response.ok) {
    throw new Error(
      `Failed to register embedding model: HTTP ${response.status}`
    );
  }
}

// ---------------------------------------------------------------------------
// Vector store creation
// ---------------------------------------------------------------------------

/**
 * Creates a new vector store in OGX and returns its ID.
 */
export async function createVectorStore(
  config: OgxClientConfig,
  name: string,
  embeddingModel: string,
  embeddingDimension: number
): Promise<string> {
  const doFetch = config.fetchFn ?? globalThis.fetch;

  const response = await doFetch(`${config.ogxBaseUrl}/v1/vector_stores`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      embedding_model: embeddingModel,
      embedding_dimension: embeddingDimension,
    }),
  });

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.text();
      detail = `: ${body}`;
    } catch { /* ignore */ }
    throw new Error(
      `Failed to create vector store: HTTP ${response.status}${detail}`
    );
  }

  const data = (await response.json()) as { id: string };
  return data.id;
}

// ---------------------------------------------------------------------------
// File upload
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Uploads a local file to OGX file storage.
 * Returns the file ID from the OGX response.
 */
export async function uploadFile(
  config: OgxClientConfig,
  filePath: string
): Promise<string> {
  const doFetch = config.fetchFn ?? globalThis.fetch;

  const fileBuffer = fs.readFileSync(filePath);
  const blob = new Blob([fileBuffer]);
  const fileName = path.basename(filePath);

  const formData = new FormData();
  formData.append('file', blob, fileName);
  formData.append('purpose', 'assistants');

  const response = await doFetch(`${config.ogxBaseUrl}/v1/files`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(
      `Failed to upload file: HTTP ${response.status}`
    );
  }

  const data = (await response.json()) as { id: string };
  return data.id;
}

// ---------------------------------------------------------------------------
// File attachment to vector store
// ---------------------------------------------------------------------------

/**
 * Attaches a previously uploaded file to a vector store.
 */
export async function attachFileToVectorStore(
  config: OgxClientConfig,
  vectorStoreId: string,
  fileId: string
): Promise<void> {
  const doFetch = config.fetchFn ?? globalThis.fetch;

  const response = await doFetch(
    `${config.ogxBaseUrl}/v1/vector_stores/${vectorStoreId}/files`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Failed to attach file to vector store: HTTP ${response.status}`
    );
  }
}

// ---------------------------------------------------------------------------
// File status polling
// ---------------------------------------------------------------------------

/**
 * Polls the file attachment status until it reaches a terminal state
 * ("completed" or "failed") or the timeout is exceeded.
 */
export async function pollFileStatus(
  config: OgxClientConfig,
  vectorStoreId: string,
  fileId: string,
  timeoutMs: number = 120_000
): Promise<string> {
  const doFetch = config.fetchFn ?? globalThis.fetch;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const response = await doFetch(
      `${config.ogxBaseUrl}/v1/vector_stores/${vectorStoreId}/files/${fileId}`,
      { method: 'GET' }
    );

    if (!response.ok) {
      throw new Error(
        `Failed to poll file status: HTTP ${response.status}`
      );
    }

    const data = (await response.json()) as { status: string };

    if (data.status === 'completed' || data.status === 'failed') {
      return data.status;
    }

    await sleep(1000);
  }

  throw new Error('Failed to poll file status: timeout');
}
