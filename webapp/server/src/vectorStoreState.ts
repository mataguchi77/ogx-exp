import { readFile, writeFile, rename, unlink } from 'fs/promises';

export interface VectorStoreStateData {
  version: number;
  vectorStoreId: string;
  embeddingModel: string;
  createdAt: string;
}

export interface PersistenceConfig {
  statePath: string;
}

const DEFAULT_STATE_PATH = '.vector-store-state.json';

/**
 * Creates a PersistenceConfig from environment variables.
 * Reads VECTOR_STORE_STATE_PATH from the provided env object (defaults to process.env).
 * Default path: webapp/server/.vector-store-state.json
 */
export function createPersistenceConfig(
  env?: Record<string, string | undefined>
): PersistenceConfig {
  const source = env ?? process.env;
  const statePath = source['VECTOR_STORE_STATE_PATH'] || DEFAULT_STATE_PATH;
  return { statePath };
}

/**
 * Loads the vector store state from disk.
 * Returns null if the file doesn't exist, is invalid JSON, or is missing vectorStoreId.
 * Never throws — logs warnings and returns null on any error.
 */
export async function loadVectorStoreState(
  statePath: string
): Promise<VectorStoreStateData | null> {
  try {
    let content: string;
    try {
      content = await readFile(statePath, 'utf-8');
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        console.info(`Vector store state file not found: ${statePath}`);
        return null;
      }
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      console.warn(`Failed to parse vector store state file as JSON: ${statePath}`);
      return null;
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>)['vectorStoreId'] !== 'string' ||
      (parsed as Record<string, unknown>)['vectorStoreId'] === ''
    ) {
      console.warn(`Failed to load vector store state: missing or invalid vectorStoreId in ${statePath}`);
      return null;
    }

    return parsed as VectorStoreStateData;
  } catch (err: unknown) {
    console.warn(`Failed to load vector store state: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Saves the vector store state to disk atomically.
 * Writes to a .tmp file first, then renames to the target path.
 * Never throws — logs errors and returns silently on failure.
 */
export async function saveVectorStoreState(
  statePath: string,
  data: VectorStoreStateData
): Promise<void> {
  const tmpPath = `${statePath}.tmp`;
  try {
    const json = JSON.stringify(data, null, 2);
    await writeFile(tmpPath, json, 'utf-8');
    await rename(tmpPath, statePath);
  } catch (err: unknown) {
    console.warn(`Failed to save vector store state: ${(err as Error).message}`);
    try {
      await unlink(tmpPath);
    } catch {
      // Silently ignore cleanup failure
    }
  }
}

/**
 * Deletes the state file (used when a persisted store is found to be stale).
 * Never throws — logs errors and returns silently on failure.
 */
export async function deleteStateFile(
  statePath: string
): Promise<void> {
  try {
    await unlink(statePath);
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    console.warn(`Failed to delete vector store state file: ${(err as Error).message}`);
  }
}
