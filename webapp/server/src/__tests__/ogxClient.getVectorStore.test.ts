import { describe, it, expect } from 'vitest';
import { getVectorStore, OgxClientConfig } from '../ogxClient.js';

function createMockFetch(status: number, body: unknown = {}): typeof fetch {
  return async () =>
    ({
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    }) as Response;
}

describe('getVectorStore', () => {
  const baseConfig: OgxClientConfig = {
    ogxBaseUrl: 'http://localhost:8321',
  };

  it('returns the vector store object on HTTP 200', async () => {
    const storeData = { id: 'vs_abc123', name: 'test-store', status: 'completed' };
    const config: OgxClientConfig = {
      ...baseConfig,
      fetchFn: createMockFetch(200, storeData),
    };

    const result = await getVectorStore(config, 'vs_abc123');
    expect(result).toEqual(storeData);
  });

  it('returns null on HTTP 404', async () => {
    const config: OgxClientConfig = {
      ...baseConfig,
      fetchFn: createMockFetch(404, { detail: 'Vector store not found' }),
    };

    const result = await getVectorStore(config, 'vs_nonexistent');
    expect(result).toBeNull();
  });

  it('throws on HTTP 500 with correct error message', async () => {
    const config: OgxClientConfig = {
      ...baseConfig,
      fetchFn: createMockFetch(500),
    };

    await expect(getVectorStore(config, 'vs_abc123')).rejects.toThrow(
      'Failed to retrieve vector store: HTTP 500'
    );
  });

  it('throws on HTTP 403 with correct error message', async () => {
    const config: OgxClientConfig = {
      ...baseConfig,
      fetchFn: createMockFetch(403),
    };

    await expect(getVectorStore(config, 'vs_abc123')).rejects.toThrow(
      'Failed to retrieve vector store: HTTP 403'
    );
  });

  it('sends GET request to the correct URL', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    const mockFetch: typeof fetch = async (input, init) => {
      capturedUrl = input as string;
      capturedMethod = init?.method ?? 'GET';
      return { status: 200, ok: true, json: async () => ({ id: 'vs_test', name: 'n', status: 's' }) } as Response;
    };

    const config: OgxClientConfig = { ...baseConfig, fetchFn: mockFetch };
    await getVectorStore(config, 'vs_test123');

    expect(capturedUrl).toBe('http://localhost:8321/v1/vector_stores/vs_test123');
    expect(capturedMethod).toBe('GET');
  });
});
