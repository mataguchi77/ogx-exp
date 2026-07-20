# Bedrock AgentCore Web App — Architecture Design

## Overview

A full-stack web application providing a chat interface to LLMs with RAG (Retrieval-Augmented Generation) support. The system supports two RAG backends:

- **AWS mode** — queries an AWS Bedrock AgentCore knowledge base via MCP tool
- **Ollama mode** — queries a local OGX vector store via `file_search` tool

The backend is an Express server that proxies requests to OGX (an OpenAI-compatible API gateway), and the frontend is a React SPA that renders streamed responses in real time.

---

## Architecture Topology

```mermaid
graph TD
    subgraph WS["Windows Server 2025 Datacenter"]
        Browser["Browser\nEdge / Chrome\n:5173 (dev) / :5000 (prod)"]

        subgraph TS["TypeScript Backend  :5000"]
            TM["TokenManager\nOAuth2 lifecycle\nproactive refresh"]
            CR["chatRouter\nPOST /api/chat/stream\nSSE streaming"]
            AR["agentRouter\nPOST /api/invoke-agent"]
            IR["ingestRouter\nPOST /api/ingest\n(Ollama RAG only)"]
            TI["tokenInfo\nGET /api/token-info"]
            RC["RagConfig\nRAG_SOURCE switch\nollama | aws"]
            SPA["React SPA\nstatic files from client/"]
        end

        subgraph OGX["OGX Server  :8321"]
            RESP["inline::builtin\nResponses API\nagentic loop"]
            INF["remote::ollama\ninference provider"]
            MCP["remote::model-context-protocol\ntool runtime"]
            VS["inline::sqlite-vec\nvector store provider"]
        end

        Ollama["Ollama  :11434\nllama3.1:8b (chat)\nmxbai-embed-large (embed)"]
    end

    Cognito["Amazon Cognito\nOAuth2 IdP\nclient_credentials grant"]
    Gateway["Bedrock AgentCore Gateway\nMCP endpoint  HTTPS\nKnowledge Base"]

    Browser -->|"GET / POST /api/*"| TS
    TM -->|"client_credentials grant  HTTPS"| Cognito

    CR -->|"POST /v1/responses\nstream:true + mcp/file_search tool"| RESP
    AR -->|"POST /v1/responses\nmodel + MCP tool + bearer token"| RESP
    IR -->|"POST /v1/vector_stores\nPOST /v1/files"| VS

    RESP -->|"1 chat/completions\n(decide tool call)"| INF
    INF -->|"inference"| Ollama
    RESP -->|"2 tools/call + Bearer token"| MCP
    MCP -->|"JSON-RPC 2.0  HTTPS"| Gateway
    RESP -->|"3 chat/completions\n(synthesize answer)"| INF
    VS -->|"embeddings"| Ollama
```

---

## Component Responsibilities

| Component | Technology | Responsibility |
|-----------|-----------|----------------|
| **client/** | React 18, Vite 5, TypeScript | Renders chat UI, manages streaming state, parses SSE events |
| **server/** | Express 4, TypeScript, tsx | API proxy layer, request validation, token management, RAG routing |
| **OGX** | Python (ogx stack) | OpenAI-compatible API gateway with Responses API, vector stores, and file storage |
| **Ollama** | Go binary | Local LLM inference (chat + embeddings) |
| **Cognito** | AWS managed | Issues OAuth2 access tokens via client_credentials grant |
| **Bedrock AgentCore** | AWS managed | MCP server providing knowledge base queries over a gateway |

---

## RAG Mode Comparison

| Aspect | `RAG_SOURCE=aws` | `RAG_SOURCE=ollama` |
|--------|-------------------|---------------------|
| Tool type | `mcp` | `file_search` |
| Knowledge source | AWS Bedrock Knowledge Base | Local OGX vector store (sqlite-vec) |
| Authentication | Bearer token from Cognito | None (local) |
| Document ingestion | AWS console / SDK | POST /api/ingest |
| Vector store persistence | Managed by AWS | `.vector-store-state.json` (local file) |
| Embedding model | Managed by AWS | `mxbai-embed-large` via Ollama |

---

## Sequence Diagrams

### 1. Streaming Chat (RAG-augmented)

```mermaid
sequenceDiagram
    participant U as Browser (React)
    participant S as Express Server :5000
    participant O as OGX Server :8321
    participant L as Ollama :11434

    U->>S: POST /api/chat/stream<br/>{messages: [...]}
    S->>S: Validate messages (non-empty, ≤100)
    
    alt RAG_SOURCE = aws
        S->>S: tokenManager.getToken()
        alt Token null
            S-->>U: 503 "OAuth2 token unavailable"
        end
        S->>S: Build tools: [{type:"mcp", server_url, authorization}]
    else RAG_SOURCE = ollama
        alt vectorStoreId exists
            S->>S: Build tools: [{type:"file_search", vector_store_ids}]
        else no vectorStoreId
            S->>S: Build tools: []
        end
    end

    S->>O: POST /v1/responses<br/>{model, input, tools, stream:true}
    O->>L: Inference request
    L-->>O: Token stream

    loop SSE events
        O-->>S: event: response.output_text.delta<br/>data: {"type":"...","delta":"Hello"}
        S-->>U: (raw SSE bytes piped through)
        U->>U: parseSseLine() → append to buffer
    end

    O-->>S: event: response.completed
    S-->>U: (piped through)
    U->>U: Commit buffer as assistant message
```

### 2. Agent Invocation (non-streaming)

```mermaid
sequenceDiagram
    participant U as Browser
    participant S as Express Server
    participant O as OGX Server
    participant B as Bedrock AgentCore

    U->>S: POST /api/invoke-agent<br/>{query, endpoint?, sessionId?}
    S->>S: Validate query (non-empty, ≤10k chars)
    
    alt endpoint = aws
        S->>S: tokenManager.getToken()
        S->>S: Build payload with mcp tool
    else endpoint = ollama
        S->>S: Build payload with file_search tool
    end

    S->>O: POST /v1/responses<br/>{model, input, tools}
    
    alt endpoint = aws
        O->>B: MCP call (invoke_bedrock_agent)
        B-->>O: Knowledge base response
    else endpoint = ollama
        O->>O: file_search in vector store
    end

    O-->>S: {output: [{type:"message", content:[...]}]}
    S->>S: extractContent(output)
    S-->>U: {success:true, content:{text, images}, sessionId}
```

### 3. Document Ingestion (Ollama RAG only)

```mermaid
sequenceDiagram
    participant U as Browser / CLI
    participant S as Express Server
    participant O as OGX Server

    U->>S: POST /api/ingest<br/>{filePath: "C:\...\doc.pdf"}
    S->>S: Validate filePath exists on disk

    alt vectorStoreId exists (reuse)
        S->>S: Use existing vectorStoreId
    else first ingestion
        S->>O: POST /v1/vector_stores<br/>{name, embedding_model, embedding_dimension}
        O-->>S: {id: "vs_abc123"}
        S->>S: Save to .vector-store-state.json
    end

    S->>O: POST /v1/files (multipart)<br/>file + purpose:"assistants"
    O-->>S: {id: "file_xyz"}
    
    S->>O: POST /v1/vector_stores/{id}/files<br/>{file_id, chunking_strategy}
    O-->>S: 200 OK

    loop Poll until terminal
        S->>O: GET /v1/vector_stores/{id}/files/{file_id}
        O-->>S: {status: "in_progress"|"completed"|"failed"}
    end

    S-->>U: {success:true, fileId, vectorStoreId, filePath}
```

### 4. Token Lifecycle (OAuth2 client_credentials)

```mermaid
sequenceDiagram
    participant S as Express Server
    participant C as Amazon Cognito

    Note over S: Startup — initialize()
    loop Retry up to 3 times (5s delay)
        S->>C: POST /oauth2/token<br/>grant_type=client_credentials
        C-->>S: {access_token, expires_in, scope}
    end
    S->>S: Store token, schedule refresh at 80% TTL

    Note over S: Proactive refresh
    S->>C: POST /oauth2/token
    C-->>S: New token
    S->>S: Update state, reschedule

    Note over S: Refresh failure (3 retries exhausted)
    S->>S: Mark token invalid
    loop Reacquire every 60s
        S->>C: POST /oauth2/token
        alt Success
            C-->>S: New token
            S->>S: Restore valid state, stop loop
        else Failure
            S->>S: Continue loop
        end
    end
```

---

## Server Startup Sequence

1. Load environment variables from `webapp/.env`
2. Validate required config (gateway URL, Cognito credentials)
3. Create RAG config from `RAG_SOURCE`
4. If Ollama mode: load persisted vector store state → validate via GET `/v1/vector_stores/{id}` → restore or delete stale state
5. Acquire initial OAuth2 token from Cognito (3 retries)
6. Wire Express routes
7. Serve React SPA from `server/public/`
8. Listen on configured port (default 5000)

---

## Directory Structure

```
webapp/
├── .env                          # Shared environment config
├── package.json                  # Workspace root (concurrently)
├── client/                       # React frontend
│   ├── vite.config.ts            # Vite + Vitest config
│   ├── src/
│   │   ├── App.tsx               # Root component
│   │   ├── components/
│   │   │   ├── ChatApp.tsx       # Chat UI container
│   │   │   ├── MessageList.tsx   # Scrollable message list
│   │   │   ├── InputArea.tsx     # Text input + Send/Stop buttons
│   │   │   └── ClearButton.tsx   # Clear conversation button
│   │   ├── hooks/
│   │   │   └── useStreamingChat.ts  # Streaming state machine
│   │   ├── utils/
│   │   │   └── sseParser.ts      # SSE line parser (dual format)
│   │   └── types.ts              # Client-side type definitions
│   └── index.html
├── server/                       # Express backend
│   ├── src/
│   │   ├── index.ts              # Entry point, route wiring
│   │   ├── config.ts             # .env loading + validation
│   │   ├── chatRouter.ts         # POST /api/chat/stream
│   │   ├── agentRouter.ts        # POST /api/invoke-agent
│   │   ├── ingestRouter.ts       # POST /api/ingest
│   │   ├── tokenManager.ts       # OAuth2 token lifecycle
│   │   ├── tokenInfo.ts          # GET /api/token-info
│   │   ├── ragConfig.ts          # RAG source config factory
│   │   ├── ogxClient.ts          # OGX HTTP client
│   │   ├── vectorStoreState.ts   # Persistent vector store ID
│   │   └── types.ts              # Server-side type definitions
│   └── public/                   # Built React SPA (output of vite build)
└── docs/
    └── architecture.md           # This document
```

---

## Key Design Decisions

1. **OGX as unified API gateway** — All LLM and vector store interactions go through OGX's OpenAI-compatible Responses API. The backend never calls Ollama or AWS directly for inference.

2. **Raw SSE byte piping** — The chat stream endpoint pipes bytes from OGX directly to the browser without buffering or re-serializing. This minimizes latency and memory usage.

3. **Dependency injection** — Router factories accept `config`, `tokenManager`, `ragConfig`, and optional `fetchFn` for testability. No module-level singletons.

4. **Dual RAG source via config** — A single `RAG_SOURCE` env var switches the entire application between AWS and Ollama RAG modes. The same frontend and API surface serves both.

5. **Non-enumerable secrets** — `cognitoClientSecret` is defined as non-enumerable on the config object so `JSON.stringify()` never leaks it.

6. **Atomic state persistence** — Vector store state is written atomically (write-to-temp + rename) to prevent corruption on crash. All persistence errors are non-fatal.

7. **Proactive token refresh** — The TokenManager refreshes at 80% of TTL to avoid serving requests with expired tokens. Failed refreshes degrade gracefully (token marked invalid → 503 for AWS requests).
