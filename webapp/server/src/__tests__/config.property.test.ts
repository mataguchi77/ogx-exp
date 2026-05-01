// Feature: bedrock-agentcore-web-app, Property 1: Required config variables cause startup failure
// For any combination of the four required env vars where at least one is absent or empty,
// validateConfig SHALL throw an error whose message is prefixed with "Failed to start:"

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { validateConfig } from '../config.js';

const REQUIRED_VARS = [
  'BEDROCK_AGENT_CORE_GATEWAY_URL',
  'COGNITO_TOKEN_URL',
  'COGNITO_CLIENT_ID',
  'COGNITO_CLIENT_SECRET',
] as const;

describe('Property 1: Required config variables cause startup failure', () => {
  it('throws "Failed to start:" when any required var is missing or empty', () => {
    fc.assert(
      fc.property(
        // Generate a subset of required vars that is missing (length < 4)
        fc.subarray(REQUIRED_VARS as unknown as string[], { minLength: 0, maxLength: 3 }),
        // For each present var, decide if it should be empty string instead of a value
        fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
        (presentVars, makeEmpty) => {
          const env: Record<string, string | undefined> = {
            OLLAMA_URL: 'http://localhost:11434/v1',
            OLLAMA_MODEL: 'ollama/llama3.2',
            OGX_BASE_URL: 'http://localhost:8321',
            PORT: '5000',
          };
          // Set present vars (possibly as empty string)
          REQUIRED_VARS.forEach((varName, i) => {
            if (presentVars.includes(varName)) {
              env[varName] = makeEmpty[i] ? '' : `value-for-${varName}`;
            }
            // absent vars are simply not set (undefined)
          });
          // Ensure at least one required var is missing or empty
          const hasInvalidRequired = REQUIRED_VARS.some(
            (v) => !env[v] || env[v] === ''
          );
          if (!hasInvalidRequired) return; // skip valid configs

          let threw = false;
          try {
            validateConfig(env);
          } catch (e) {
            threw = true;
            if (e instanceof Error) {
              if (!e.message.startsWith('Failed to start:')) {
                throw new Error(`Expected error message to start with "Failed to start:" but got: ${e.message}`);
              }
            }
          }
          if (!threw) {
            throw new Error('Expected validateConfig to throw but it did not');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
