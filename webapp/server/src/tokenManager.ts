import type { AppConfig, TokenInfoResponse, TokenState } from './types.js';

/**
 * Computes the proactive refresh delay in milliseconds.
 * Exported for testability (Property 5).
 */
export function computeRefreshDelay(expiresIn: number): number {
  return Math.floor(expiresIn * 0.8) * 1000;
}

const INITIAL_RETRY_ATTEMPTS = 3;
const INITIAL_RETRY_DELAY_MS = 5_000;
const REFRESH_RETRY_ATTEMPTS = 3;
const REFRESH_RETRY_DELAYS_MS = [2_000, 4_000, 8_000];
const REACQUIRE_INTERVAL_MS = 60_000;

export class TokenManager {
  private config: AppConfig;
  private fetchFn: typeof fetch;
  private tokenState: TokenState | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private reacquireInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: AppConfig, fetchFn?: typeof fetch) {
    this.config = config;
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  /**
   * Acquires the initial token, retrying up to 3 times with 5-second delays.
   * Throws "Failed to acquire initial OAuth2 token" after exhausting retries.
   */
  async initialize(): Promise<void> {
    for (let attempt = 0; attempt < INITIAL_RETRY_ATTEMPTS; attempt++) {
      try {
        await this._acquireToken();
        return;
      } catch {
        if (attempt < INITIAL_RETRY_ATTEMPTS - 1) {
          await this._sleep(INITIAL_RETRY_DELAY_MS);
        }
      }
    }
    throw new Error('Failed to acquire initial OAuth2 token');
  }

  /**
   * Returns the current access token if valid, otherwise null.
   */
  getToken(): string | null {
    if (this.tokenState?.isValid === true) {
      return this.tokenState.accessToken;
    }
    return null;
  }

  /**
   * Returns non-sensitive token metadata. Never includes accessToken.
   */
  getTokenInfo(): TokenInfoResponse {
    if (!this.tokenState) {
      return {
        expiresAt: new Date(0).toISOString(),
        remainingSeconds: 0,
        scopes: [],
      };
    }
    const remainingMs = this.tokenState.expiresAt.getTime() - Date.now();
    return {
      expiresAt: this.tokenState.expiresAt.toISOString(),
      remainingSeconds: Math.max(0, Math.floor(remainingMs / 1000)),
      scopes: this.tokenState.scopes,
    };
  }

  /**
   * Clears all timers. Call this for clean test teardown.
   */
  destroy(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.reacquireInterval !== null) {
      clearInterval(this.reacquireInterval);
      this.reacquireInterval = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async _acquireToken(): Promise<void> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.cognitoClientId,
      client_secret: this.config.cognitoClientSecret,
    });

    const response = await this.fetchFn(this.config.cognitoTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(`Failed to acquire token: HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
      scope?: string;
    };

    const expiresIn = data.expires_in;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    const scopes = data.scope ? data.scope.split(' ').filter(Boolean) : [];

    this.tokenState = {
      accessToken: data.access_token,
      expiresAt,
      scopes,
      isValid: true,
    };

    this._scheduleRefresh(expiresIn);
  }

  private _scheduleRefresh(expiresIn: number): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
    }
    const delay = computeRefreshDelay(expiresIn);
    this.refreshTimer = setTimeout(() => {
      void this._refreshWithRetry();
    }, delay);
  }

  private async _refreshWithRetry(): Promise<void> {
    for (let attempt = 0; attempt < REFRESH_RETRY_ATTEMPTS; attempt++) {
      try {
        await this._acquireToken();
        return;
      } catch {
        if (attempt < REFRESH_RETRY_ATTEMPTS - 1) {
          await this._sleep(REFRESH_RETRY_DELAYS_MS[attempt]!);
        }
      }
    }

    // All retries exhausted
    console.error('Failed to refresh OAuth2 token');
    if (this.tokenState) {
      this.tokenState.isValid = false;
    }
    this._startReacquireLoop();
  }

  private _startReacquireLoop(): void {
    if (this.reacquireInterval !== null) {
      return; // already running
    }
    this.reacquireInterval = setInterval(() => {
      void this._acquireToken().then(() => {
        // Successfully re-acquired — stop the loop
        if (this.reacquireInterval !== null) {
          clearInterval(this.reacquireInterval);
          this.reacquireInterval = null;
        }
      }).catch(() => {
        // Will retry on next interval tick
      });
    }, REACQUIRE_INTERVAL_MS);
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
