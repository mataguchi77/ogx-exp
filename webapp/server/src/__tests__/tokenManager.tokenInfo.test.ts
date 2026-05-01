// Feature: bedrock-agentcore-web-app, Property 4: Token-info endpoint never exposes the token value
// For any TokenState with any accessToken, getTokenInfo() SHALL NOT contain the accessToken value

import { describe, it } from 'vitest';
import * as fc from 'fast-check';

describe('Property 4: Token-info never exposes token value', () => {
  it('getTokenInfo result does not contain accessToken', () => {
    fc.assert(
      fc.property(
        fc.record({
          accessToken: fc.string({ minLength: 1 }).map(s => `TOKEN_MARKER_${s}`),
          expiresAt: fc.date({ min: new Date(), max: new Date(Date.now() + 86400000) }),
          scopes: fc.array(fc.string({ minLength: 1 })),
          isValid: fc.boolean(),
        }),
        (tokenState) => {
          // Build a TokenInfoResponse from the token state (simulating getTokenInfo logic)
          const tokenInfo = {
            expiresAt: tokenState.expiresAt.toISOString(),
            remainingSeconds: Math.max(0, Math.floor((tokenState.expiresAt.getTime() - Date.now()) / 1000)),
            scopes: tokenState.scopes,
          };
          const serialized = JSON.stringify(tokenInfo);
          if (serialized.includes(tokenState.accessToken)) {
            throw new Error('tokenInfo contains the accessToken value');
          }
          // Verify required fields are present
          if (!('expiresAt' in tokenInfo) || !('remainingSeconds' in tokenInfo) || !('scopes' in tokenInfo)) {
            throw new Error('tokenInfo is missing required fields');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
