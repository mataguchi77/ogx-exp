import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadVectorStoreState } from '../vectorStoreState.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('loadVectorStoreState', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vs-state-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null and logs info when file does not exist', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const result = await loadVectorStoreState(path.join(tmpDir, 'nonexistent.json'));
    expect(result).toBeNull();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
    infoSpy.mockRestore();
  });

  it('returns null and logs warning when file contains invalid JSON', async () => {
    const filePath = path.join(tmpDir, 'invalid.json');
    await fs.writeFile(filePath, 'not valid json {{{');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await loadVectorStoreState(filePath);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to parse'));
    warnSpy.mockRestore();
  });

  it('returns null and logs warning when vectorStoreId is missing', async () => {
    const filePath = path.join(tmpDir, 'missing-id.json');
    await fs.writeFile(filePath, JSON.stringify({ version: 1, embeddingModel: 'test' }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await loadVectorStoreState(filePath);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing or invalid vectorStoreId'));
    warnSpy.mockRestore();
  });

  it('returns null and logs warning when vectorStoreId is empty string', async () => {
    const filePath = path.join(tmpDir, 'empty-id.json');
    await fs.writeFile(filePath, JSON.stringify({ vectorStoreId: '' }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await loadVectorStoreState(filePath);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing or invalid vectorStoreId'));
    warnSpy.mockRestore();
  });

  it('returns null and logs warning when vectorStoreId is not a string', async () => {
    const filePath = path.join(tmpDir, 'number-id.json');
    await fs.writeFile(filePath, JSON.stringify({ vectorStoreId: 123 }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await loadVectorStoreState(filePath);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing or invalid vectorStoreId'));
    warnSpy.mockRestore();
  });

  it('returns parsed state when vectorStoreId is a valid non-empty string', async () => {
    const filePath = path.join(tmpDir, 'valid.json');
    const data = {
      version: 1,
      vectorStoreId: 'vs_abc123',
      embeddingModel: 'ollama/mxbai-embed-large',
      createdAt: '2025-01-15T10:30:00.000Z',
    };
    await fs.writeFile(filePath, JSON.stringify(data));
    const result = await loadVectorStoreState(filePath);
    expect(result).toEqual(data);
  });

  it('accepts objects with extra fields as long as vectorStoreId is valid', async () => {
    const filePath = path.join(tmpDir, 'extra-fields.json');
    const data = {
      vectorStoreId: 'vs_xyz789',
      extraField: 'hello',
      nested: { foo: 'bar' },
    };
    await fs.writeFile(filePath, JSON.stringify(data));
    const result = await loadVectorStoreState(filePath);
    expect(result).not.toBeNull();
    expect(result!.vectorStoreId).toBe('vs_xyz789');
  });

  it('never throws even on unexpected errors', async () => {
    // Pass a path that would cause a permission error or other unexpected issue
    // Using a directory path instead of a file path triggers EISDIR
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await loadVectorStoreState(tmpDir);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to load vector store state:'));
    warnSpy.mockRestore();
  });
});
