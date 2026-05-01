import { Router } from 'express';
import type { TokenManager } from './tokenManager.js';

export function createTokenInfoRouter(tokenManager: TokenManager): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.status(200).json(tokenManager.getTokenInfo());
  });
  return router;
}
