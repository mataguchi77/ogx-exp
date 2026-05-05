import { Router, type Request, type Response } from 'express';
import fs from 'fs/promises';
import type { AppConfig, IngestResponse } from './types.js';
import type { RagConfig } from './ragConfig.js';
import { setVectorStoreId } from './ragConfig.js';
import {
  createVectorStore,
  uploadFile,
  attachFileToVectorStore,
  pollFileStatus,
} from './ogxClient.js';
import type { OgxClientConfig } from './ogxClient.js';
import { saveVectorStoreState } from './vectorStoreState.js';
import type { PersistenceConfig, VectorStoreStateData } from './vectorStoreState.js';

/**
 * Creates an Express Router for POST /api/ingest.
 *
 * Orchestrates the RAG ingestion flow: validates the request, checks the file
 * exists on disk, then calls OGX to create a vector store, upload the file,
 * attach it, and poll until processing completes.
 *
 * @param appConfig         - Loaded AppConfig (ogxBaseUrl, …)
 * @param ragConfig         - RAG configuration (embedding model, dimension, vector store name)
 * @param persistenceConfig - Optional persistence config for saving vector store state
 * @param fetchFn           - Optional fetch override for testing
 */
export function createIngestRouter(
  appConfig: AppConfig,
  ragConfig: RagConfig,
  persistenceConfig?: PersistenceConfig,
  fetchFn?: typeof fetch
): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    // 1. Content-Type validation
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.includes('application/json')) {
      const body: IngestResponse = {
        success: false,
        error: 'Failed to process request: unsupported content type',
      };
      res.status(415).json(body);
      return;
    }

    // 2. filePath validation
    const { filePath } = req.body as { filePath?: unknown };
    if (
      filePath === undefined ||
      filePath === null ||
      typeof filePath !== 'string' ||
      filePath === ''
    ) {
      const body: IngestResponse = {
        success: false,
        error: 'Failed to process request: filePath is required',
      };
      res.status(400).json(body);
      return;
    }

    // 3. File existence check
    try {
      await fs.access(filePath);
    } catch {
      const body: IngestResponse = {
        success: false,
        error: 'Failed to ingest document: file not found',
      };
      res.status(400).json(body);
      return;
    }

    // 4. Orchestrate ingestion
    const ogxConfig: OgxClientConfig = {
      ogxBaseUrl: appConfig.ogxBaseUrl,
      fetchFn,
    };

    try {
      let vectorStoreId: string;
      const wasReusing = ragConfig.vectorStoreId !== null;

      if (ragConfig.vectorStoreId) {
        // Reuse existing vector store
        vectorStoreId = ragConfig.vectorStoreId;
      } else {
        // Create a new vector store
        vectorStoreId = await createVectorStore(
          ogxConfig,
          ragConfig.vectorStoreName,
          ragConfig.embeddingModel,
          ragConfig.embeddingDimension
        );

        setVectorStoreId(ragConfig, vectorStoreId);

        // Persist the new vector store state
        if (persistenceConfig) {
          const stateData: VectorStoreStateData = {
            version: 1,
            vectorStoreId,
            embeddingModel: ragConfig.embeddingModel,
            createdAt: new Date().toISOString(),
          };
          await saveVectorStoreState(persistenceConfig.statePath, stateData);
        }
      }

      const fileId = await uploadFile(ogxConfig, filePath);

      try {
        await attachFileToVectorStore(ogxConfig, vectorStoreId, fileId);
      } catch (attachErr: unknown) {
        const attachMessage = attachErr instanceof Error ? attachErr.message : String(attachErr);

        // Retry once if we were reusing an existing store and got a 404
        if (wasReusing && attachMessage.includes('404')) {
          const newVectorStoreId = await createVectorStore(
            ogxConfig,
            ragConfig.vectorStoreName,
            ragConfig.embeddingModel,
            ragConfig.embeddingDimension
          );

          setVectorStoreId(ragConfig, newVectorStoreId);
          vectorStoreId = newVectorStoreId;

          if (persistenceConfig) {
            const stateData: VectorStoreStateData = {
              version: 1,
              vectorStoreId: newVectorStoreId,
              embeddingModel: ragConfig.embeddingModel,
              createdAt: new Date().toISOString(),
            };
            await saveVectorStoreState(persistenceConfig.statePath, stateData);
          }

          // Retry attachment once with the new store
          await attachFileToVectorStore(ogxConfig, newVectorStoreId, fileId);
        } else {
          throw attachErr;
        }
      }

      const status = await pollFileStatus(ogxConfig, vectorStoreId, fileId);
      console.info(`File processing status: ${status} (vectorStoreId=${vectorStoreId}, fileId=${fileId})`);

      // 5. Check poll result
      if (status === 'failed') {
        const body: IngestResponse = {
          success: false,
          error: 'Failed to process document',
        };
        res.status(502).json(body);
        return;
      }

      // 6. Success response
      const body: IngestResponse = {
        success: true,
        fileId,
        vectorStoreId,
        filePath,
      };
      res.status(200).json(body);
    } catch (err: unknown) {
      // 7. Error handling
      const message =
        err instanceof Error ? err.message : String(err);

      if (message.includes('timeout')) {
        const body: IngestResponse = {
          success: false,
          error: 'Failed to process document: timeout',
        };
        res.status(504).json(body);
        return;
      }

      if (message.startsWith('Failed to')) {
        const body: IngestResponse = {
          success: false,
          error: message,
        };
        res.status(502).json(body);
        return;
      }

      const body: IngestResponse = {
        success: false,
        error: 'Failed to process request: internal server error',
      };
      res.status(500).json(body);
    }
  });

  return router;
}
