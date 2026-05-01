import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import type { AppConfig } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from the webapp/ root (two levels up from src/)
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

const REQUIRED_VARS = [
  'BEDROCK_AGENT_CORE_GATEWAY_URL',
  'COGNITO_TOKEN_URL',
  'COGNITO_CLIENT_ID',
  'COGNITO_CLIENT_SECRET',
] as const;

/**
 * Validates an env object and returns an AppConfig.
 * Exported separately so property tests can call it directly without side effects.
 */
export function validateConfig(env: Record<string, string | undefined>): AppConfig {
  for (const varName of REQUIRED_VARS) {
    if (!env[varName]) {
      throw new Error(`Failed to start: ${varName} is required`);
    }
  }

  // Build config without cognitoClientSecret in the object literal so we can
  // add it as a non-enumerable property. Non-enumerable properties are omitted
  // by JSON.stringify, satisfying the "secret never serialized" requirement while
  // still being accessible at runtime via config.cognitoClientSecret.
  const config = {
    gatewayUrl: env['BEDROCK_AGENT_CORE_GATEWAY_URL']!,
    cognitoTokenUrl: env['COGNITO_TOKEN_URL']!,
    cognitoClientId: env['COGNITO_CLIENT_ID']!,
    ollamaUrl: env['OLLAMA_URL'] ?? 'http://localhost:11434/v1',
    ollamaModel: env['OLLAMA_MODEL'] ?? 'ollama/llama3.2',
    ogxBaseUrl: env['OGX_BASE_URL'] ?? 'http://localhost:8321',
    port: env['PORT'] ? parseInt(env['PORT'], 10) : 5000,
  } as AppConfig;

  Object.defineProperty(config, 'cognitoClientSecret', {
    value: env['COGNITO_CLIENT_SECRET']!,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return config;
}

/**
 * Loads configuration from process.env (populated by dotenv.config() above).
 * Throws with a "Failed to start:" prefix if any required var is absent or empty.
 */
export function loadConfig(): AppConfig {
  return validateConfig(process.env as Record<string, string | undefined>);
}
