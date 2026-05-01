// Feature: bedrock-agentcore-web-app, Property 5: Token refresh is scheduled at or before 80% of expires_in
// For any expires_in duration, computeRefreshDelay SHALL return <= Math.floor(expiresIn * 0.8) * 1000

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { computeRefreshDelay } from '../tokenManager.js';

describe('Property 5: Token refresh scheduled at ≤80% of expires_in', () => {
  it('computeRefreshDelay returns <= Math.floor(expiresIn * 0.8) * 1000', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 60, max: 86400 }),
        (expiresIn) => {
          const delay = computeRefreshDelay(expiresIn);
          const maxAllowed = Math.floor(expiresIn * 0.8) * 1000;
          if (delay > maxAllowed) {
            throw new Error(`computeRefreshDelay(${expiresIn}) = ${delay} > maxAllowed ${maxAllowed}`);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
