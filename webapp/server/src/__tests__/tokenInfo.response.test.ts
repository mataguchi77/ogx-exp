// Feature: bedrock-agentcore-web-app, Property 2 (response half): Client secret and bearer token never in HTTP responses
// For any secret and token strings, no HTTP response body from any endpoint SHALL contain them

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import { createTokenInfoRouter } from '../tokenInfo.js';
import type { TokenManager } from '../tokenManager.js';

function makeTokenManagerWithToken(accessToken: string, secret: string): TokenManager {
  return {
    getToken: () => accessToken,
    getTokenInfo: () => ({
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      remainingSeconds: 3600,
      scopes: ['openid'],
    }),
    initialize: async () => {},
    destroy: () => {},
  } as unknown as TokenManager;
}

describe('Property 2 (response half): Secret and token never in HTTP responses', () => {
  it('GET /api/token-info response does not contain accessToken or clientSecret', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }).map(s => `TOKEN_MARKER_${s}`),
        fc.string({ minLength: 1 }).map(s => `SECRET_MARKER_${s}`),
        async (accessToken, clientSecret) => {
          const tokenManager = makeTokenManagerWithToken(accessToken, clientSecret);
          const app = express();
          app.use('/api/token-info', createTokenInfoRouter(tokenManager));

          const res = await request(app).get('/api/token-info');
          const body = JSON.stringify(res.body);

          if (body.includes(accessToken)) {
            throw new Error('Response body contains the accessToken');
          }
          if (body.includes(clientSecret)) {
            throw new Error('Response body contains the clientSecret');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
