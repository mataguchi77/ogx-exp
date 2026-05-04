import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from './config.js';
import { TokenManager } from './tokenManager.js';
import { createAgentRouter } from './agentRouter.js';
import { createTokenInfoRouter } from './tokenInfo.js';
import { createRagConfig } from './ragConfig.js';
import type { RagConfig } from './ragConfig.js';
import { createIngestRouter } from './ingestRouter.js';

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
  if (useOllamaRag) {
    app.use('/api/ingest', createIngestRouter(config, ragConfig));
  }
  app.use('/api/invoke-agent', createAgentRouter(config, tokenManager, undefined, useOllamaRag ? ragConfig : undefined));
  app.use('/api/token-info', createTokenInfoRouter(tokenManager));

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
