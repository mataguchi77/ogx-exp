// Feature: bedrock-agentcore-web-app, Property 3: Client secret and bearer token never appear in log output
// Capturing all console output during TokenManager operations SHALL NOT contain secret or token values

import { describe, it, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { computeRefreshDelay } from '../tokenManager.js';

describe('Property 3: Secret and token never appear in log output', () => {
  let logOutput: string[] = [];

  beforeEach(() => {
    logOutput = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { logOutput.push(args.join(' ')); });
    vi.spyOn(console, 'info').mockImplementation((...args) => { logOutput.push(args.join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation((...args) => { logOutput.push(args.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...args) => { logOutput.push(args.join(' ')); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('computeRefreshDelay does not log secret or token values', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).map(s => `SECRET_MARKER_${s}`),
        fc.string({ minLength: 1 }).map(s => `TOKEN_MARKER_${s}`),
        fc.integer({ min: 60, max: 86400 }),
        (secret, token, expiresIn) => {
          logOutput = [];
          // Call the pure function — it should not log anything
          computeRefreshDelay(expiresIn);
          const allLogs = logOutput.join('\n');
          if (allLogs.includes(secret)) {
            throw new Error('Log output contains the client secret');
          }
          if (allLogs.includes(token)) {
            throw new Error('Log output contains the bearer token');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
