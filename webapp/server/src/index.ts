import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from './config.js';
import { TokenManager } from './tokenManager.js';
import { createAgentRouter } from './agentRouter.js';
import { createTokenInfoRouter } from './tokenInfo.js';
import { createRagConfig, setVectorStoreId } from './ragConfig.js';
import type { RagConfig } from './ragConfig.js';
import { createIngestRouter } from './ingestRouter.js';
import { createPersistenceConfig, loadVectorStoreState, deleteStateFile } from './vectorStoreState.js';
import type { PersistenceConfig } from './vectorStoreState.js';
import { getVectorStore } from './ogxClient.js';
import type { OgxClientConfig } from './ogxClient.js';
import { createChatRouter } from './chatRouter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  // Load and validate config (throws "Failed to start: ..." if invalid)
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  // Create RAG configuration (always created; RAG_SOURCE controls behaviour)
  const ragConfig: RagConfig = createRagConfig();
  const useOllamaRag = ragConfig.ragSource === 'ollama';
  console.info(`RAG source: ${ragConfig.ragSource}`);
  if (useOllamaRag) {
    console.info(`Ollama RAG — embedding model: ${ragConfig.embeddingModel}, dimension: ${ragConfig.embeddingDimension}`);
  }

  // Startup validation: load and validate persisted vector store state (Ollama RAG only).
  // When RAG_SOURCE=aws, no persistence file operations or validation occur (Req 8.3).
  let persistenceConfig: PersistenceConfig | undefined;
  if (useOllamaRag) {
    persistenceConfig = createPersistenceConfig();
    const state = await loadVectorStoreState(persistenceConfig.statePath);

    if (state) {
      const ogxConfig: OgxClientConfig = { ogxBaseUrl: config.ogxBaseUrl };
      try {
        const store = await getVectorStore(ogxConfig, state.vectorStoreId);
        if (store) {
          setVectorStoreId(ragConfig, state.vectorStoreId);
          console.info(`Restored persisted vector store: ${state.vectorStoreId}`);
        } else {
          // 404 — store no longer exists
          await deleteStateFile(persistenceConfig.statePath);
          console.warn(`Persisted vector store no longer exists: ${state.vectorStoreId}`);
        }
      } catch (err) {
        // Network or other error — proceed without the persisted store (do NOT delete file)
        console.warn(`Failed to validate persisted vector store: ${(err as Error).message}`);
      }
    }
  }

  // Log startup info — never log the client secret
  console.info('Starting Bedrock AgentCore Web App');
  console.info(`Gateway URL: ${config.gatewayUrl}`);
  console.info(`Cognito token URL: ${config.cognitoTokenUrl}`);
  console.info(`Ollama URL: ${config.ollamaUrl}`);

  // Initialize token manager
  const tokenManager = new TokenManager(config);
  try {
    await tokenManager.initialize();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  // Build Express app
  const app = express();
  app.use(express.json());

  // API routes
  // Persistence and ingestion are only available for Ollama RAG.
  // When RAG_SOURCE=aws, no persistence file operations or ingest routing occur (Req 8.3).
  if (useOllamaRag) {
    app.use('/api/ingest', createIngestRouter(config, ragConfig, persistenceConfig));
  }
  app.use('/api/invoke-agent', createAgentRouter(config, tokenManager, undefined, useOllamaRag ? ragConfig : undefined));
  app.use('/api/token-info', createTokenInfoRouter(tokenManager));
  app.use('/api/chat/stream', createChatRouter(config, tokenManager, ragConfig));

  // Serve React SPA static files
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  // SPA fallback — serve index.html for all non-API GET routes
  app.get('*', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.listen(config.port, () => {
    console.info(`Server listening on port ${config.port}`);
  });
}

main().catch((err: unknown) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
