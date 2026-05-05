import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { saveVectorStoreState, loadVectorStoreState } from '../vectorStoreState.js';
import type { VectorStoreStateData } from '../vectorStoreState.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('saveVectorStoreState', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vs-state-save-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const validData: VectorStoreStateData = {
    version: 1,
    vectorStoreId: 'vs_abc123',
    embeddingModel: 'ollama/mxbai-embed-large',
    createdAt: '2025-01-15T10:30:00.000Z',
  };

  it('writes a valid JSON file with all required fields', async () => {
    const filePath = path.join(tmpDir, 'state.json');
    await saveVectorStoreState(filePath, validData);

    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.version).toBe(1);
    expect(parsed.vectorStoreId).toBe('vs_abc123');
    expect(parsed.embeddingModel).toBe('ollama/mxbai-embed-large');
    expect(parsed.createdAt).toBe('2025-01-15T10:30:00.000Z');
  });

  it('writes pretty-printed JSON with 2-space indent', async () => {
    const filePath = path.join(tmpDir, 'state.json');
    await saveVectorStoreState(filePath, validData);

    const content = await fs.readFile(filePath, 'utf-8');
    const expected = JSON.stringify(validData, null, 2);
    expect(content).toBe(expected);
  });

  it('performs atomic write (no .tmp file remains after success)', async () => {
    const filePath = path.join(tmpDir, 'state.json');
    await saveVectorStoreState(filePath, validData);

    const files = await fs.readdir(tmpDir);
    expect(files).toEqual(['state.json']);
    expect(files).not.toContain('state.json.tmp');
  });

  it('round-trips correctly with loadVectorStoreState', async () => {
    const filePath = path.join(tmpDir, 'state.json');
    await saveVectorStoreState(filePath, validData);

    const loaded = await loadVectorStoreState(filePath);
    expect(loaded).toEqual(validData);
  });

  it('never throws on write failure — logs warning instead', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Use a path in a non-existent directory to trigger ENOENT on writeFile
    const filePath = path.join(tmpDir, 'nonexistent-dir', 'subdir', 'state.json');

    await expect(saveVectorStoreState(filePath, validData)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to save vector store state:'));
    warnSpy.mockRestore();
  });

  it('attempts to clean up .tmp file on rename failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Write to a valid tmp location but make the target a directory so rename fails
    const targetDir = path.join(tmpDir, 'target-is-dir');
    await fs.mkdir(targetDir);

    await expect(saveVectorStoreState(targetDir, validData)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to save vector store state:'));

    // Verify .tmp file was cleaned up (or at least the function didn't throw)
    const files = await fs.readdir(tmpDir);
    expect(files).not.toContain('target-is-dir.tmp');
    warnSpy.mockRestore();
  });

  it('overwrites an existing state file', async () => {
    const filePath = path.join(tmpDir, 'state.json');
    await saveVectorStoreState(filePath, validData);

    const updatedData: VectorStoreStateData = {
      version: 1,
      vectorStoreId: 'vs_new456',
      embeddingModel: 'ollama/nomic-embed-text',
      createdAt: '2025-02-20T14:00:00.000Z',
    };
    await saveVectorStoreState(filePath, updatedData);

    const loaded = await loadVectorStoreState(filePath);
    expect(loaded).toEqual(updatedData);
  });
});
