// Feature: bedrock-agentcore-web-app, Property 2 (config half): Client secret never serialized
// For any AppConfig with any cognitoClientSecret value,
// JSON.stringify(config) SHALL NOT contain the secret value

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { validateConfig } from '../config.js';

describe('Property 2 (config half): Client secret never serialized', () => {
  it('JSON.stringify of AppConfig does not contain the client secret', () => {
    fc.assert(
      fc.property(
        // Use a unique prefix to ensure the secret is distinguishable from other
        // field values (e.g. URLs) that may contain short common substrings.
        fc.string({ minLength: 1 }).map((s) => `SECRET_UNIQUE_MARKER_${s}`),
        (secret) => {
          const env: Record<string, string | undefined> = {
            BEDROCK_AGENT_CORE_GATEWAY_URL: 'https://example.com/mcp',
            COGNITO_TOKEN_URL: 'https://example.com/token',
            COGNITO_CLIENT_ID: 'client-id',
            COGNITO_CLIENT_SECRET: secret,
            OLLAMA_URL: 'http://localhost:11434/v1',
            OLLAMA_MODEL: 'ollama/llama3.2',
            OGX_BASE_URL: 'http://localhost:8321',
            PORT: '5000',
          };
          const config = validateConfig(env);
          const serialized = JSON.stringify(config);
          if (serialized.includes(secret)) {
            throw new Error(`JSON.stringify(config) contains the client secret`);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
