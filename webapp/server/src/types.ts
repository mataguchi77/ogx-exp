// AppConfig — loaded from environment variables
export interface AppConfig {
  gatewayUrl: string;           // BEDROCK_AGENT_CORE_GATEWAY_URL (required)
  cognitoTokenUrl: string;      // COGNITO_TOKEN_URL (required)
  cognitoClientId: string;      // COGNITO_CLIENT_ID (required)
  cognitoClientSecret: string;  // COGNITO_CLIENT_SECRET (required, never serialized)
  ollamaUrl: string;            // OLLAMA_URL (default: http://localhost:11434/v1)
  ollamaModel: string;          // OLLAMA_MODEL (default: ollama/llama3.2)
  ogxBaseUrl: string;           // OGX_BASE_URL (default: http://localhost:8321)
  port: number;                 // PORT (default: 5000)
}

// TokenState — in-memory only, never serialized
export interface TokenState {
  accessToken: string;    // in-memory only, never serialized
  expiresAt: Date;
  scopes: string[];
  isValid: boolean;
}

// API request/response types
export interface InvokeAgentRequest {
  query: string;        // 1–10,000 chars
  sessionId?: string;   // UUID, optional
}

export interface ImageBlock {
  alt: string;
  url: string;
}

export interface ContentBlock {
  text: string[];
  images: ImageBlock[];
}

export interface InvokeAgentResponse {
  success: boolean;
  content?: ContentBlock;
  sessionId?: string;
  error?: string;
}

export interface TokenInfoResponse {
  expiresAt: string;        // ISO-8601
  remainingSeconds: number;
  scopes: string[];
  // accessToken is intentionally absent
}

// OGX Responses API payload types
export interface OgxMcpTool {
  type: "mcp";
  server_url: string;       // BEDROCK_AGENT_CORE_GATEWAY_URL
  server_label: string;     // "bedrock-agentcore"
  authorization: string;    // "Bearer <cognito_token>"
}

export interface OgxFileSearchTool {
  type: "file_search";
  vector_store_ids: string[];
}

export interface OgxResponsesRequest {
  model: string;
  input: Array<{ role: string; content: string }>;
  tools: Array<OgxMcpTool | OgxFileSearchTool>;
  instructions?: string;
}

// Ingestion endpoint types
export interface IngestRequest {
  filePath: string;
}

export interface IngestResponse {
  success: boolean;
  fileId?: string;
  vectorStoreId?: string;
  filePath?: string;
  error?: string;
}

export interface OgxResponsesOutput {
  output: Array<{
    type: string;
    role?: string;
    content?: Array<{
      type: string;  // "output_text", "text", "image_url", "refusal", etc.
      text?: string;
      image_url?: { url: string; detail?: string };
    }>;
  }>;
}
