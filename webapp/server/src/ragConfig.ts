export const vectorStoreName = "rag-documents";

export type RagSource = "ollama" | "aws";

export interface RagConfig {
  readonly ragSource: RagSource;
  readonly embeddingModel: string;
  readonly embeddingDimension: number;
  readonly vectorStoreName: string;
  vectorStoreId: string | null;
}

/**
 * Reads RAG_SOURCE from the environment and normalises it.
 * Returns "ollama" or "aws" (default: "aws").
 */
export function getRagSource(
  env?: Record<string, string | undefined>
): RagSource {
  const source = env ?? process.env;
  const raw = (source["RAG_SOURCE"] ?? "").trim().toLowerCase();
  return raw === "ollama" ? "ollama" : "aws";
}

/**
 * Creates a RagConfig from the provided env object (defaults to process.env).
 * Pure factory — no I/O, no side effects.
 *
 * The embedding model settings are always read so they stay in the config
 * regardless of which RAG source is active. The caller decides whether to
 * act on them based on `ragSource`.
 */
export function createRagConfig(
  env?: Record<string, string | undefined>
): RagConfig {
  const source = env ?? process.env;
  const dimensionRaw = source["EMBEDDING_DIMENSION"];
  const dimension = dimensionRaw ? parseInt(dimensionRaw, 10) : 1024;

  return {
    ragSource: getRagSource(env),
    embeddingModel: `ollama/${source["EMBEDDING_MODEL"] || "mxbai-embed-large"}`,
    embeddingDimension: Number.isFinite(dimension) && dimension > 0 ? dimension : 1024,
    vectorStoreName,
    vectorStoreId: null,
  };
}

export function getVectorStoreId(config: RagConfig): string | null {
  return config.vectorStoreId;
}

export function setVectorStoreId(config: RagConfig, id: string): void {
  config.vectorStoreId = id;
}
