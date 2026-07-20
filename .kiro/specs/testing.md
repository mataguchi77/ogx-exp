# Testing Guide

PowerShell commands for testing on Windows Server 2025.

---

## Prerequisites

| Component        | Required state                                                       |
| ---------------- | -------------------------------------------------------------------- |
| Ollama           | Running (`ollama serve`) with models loaded                          |
| OGX              | Running on port 8321 (`uv run ogx stack run webapp/ogx-config.yaml`) |
| Node.js          | Installed (check with `node --version`)                              |
| npm dependencies | Installed (`npm install` once from `webapp\`)                        |

---

## 1. Start Ollama and OGX (from the repo root)

```powershell
# If it is not running
ollama serve
# Delete the persistent sqlite-vec storage if needed
Remove-Item -Recurse -Force "$env:USERPROFILE\.ogx\bedrock-agentcore-webapp"
# Start OGX
uv run ogx stack run webapp/ogx-config.yaml
```

Wait for `Uvicorn running on http://:8321`. If OGX was already running, restart it to pick up config changes.

## 2. Warm up Ollama models

The first request loads each model into memory and can take over a minute. Run these once before testing.

```powershell
# Chat model
Invoke-RestMethod -Uri http://localhost:11434/api/generate `
  -Method POST -ContentType "application/json" `
  -Body '{"model": "llama3.1:8b", "prompt": "hi", "stream": false}'

# Embedding model
Invoke-RestMethod -Uri http://localhost:11434/api/embeddings `
  -Method POST -ContentType "application/json" `
  -Body '{"model": "mxbai-embed-large", "prompt": "hello"}'

# Check the status
ollama ps
```

---

## 3. Development Mode

Start both the React frontend and the Express backend together (from `webapp\`):

```powershell
npm run dev
```

This uses `concurrently` to launch:

- Vite dev server (frontend) on `http://localhost:5173`
- Express backend on `http://localhost:5000`

Wait for `Server listening on port 5000` in the output. The startup log shows `RAG source: aws` or `RAG source: ollama` depending on the `RAG_SOURCE` value in `webapp\.env`.

Open Chrome at `http://localhost:5173` — API calls are proxied to port 5000 automatically.

---

## 4. Test — Agent Query (AWS Knowledge Base)

Ensure `RAG_SOURCE=aws` in `webapp\.env` and restart the backend.

```powershell
$body = @{ query = "What is the infrastructure automation defined by AAP?" } | ConvertTo-Json
$res = Invoke-RestMethod -Uri http://localhost:5000/api/invoke-agent `
  -Method POST `
  -ContentType "application/json" `
  -Body $body
$res | ConvertTo-Json -Depth 10
```

---

## 5. Test — RAG Document Ingestion (Local Ollama Vector DB)

### 5.1 Switch to Ollama RAG

Change `RAG_SOURCE` in `webapp\.env`:

```dotenv
RAG_SOURCE=ollama
```

The `EMBEDDING_MODEL` and `EMBEDDING_DIMENSION` values should already be present. Restart the backend:

```powershell
npm run dev
```

The startup log should show `RAG source: ollama` with the embedding model details.

### 5.2 Ingest a document

Replace the `filePath` value with the absolute path to a local file:

```powershell
$body = @{ filePath = "C:\Users\sso-taguchi.masahiro\Downloads\leeds-facup-2026.txt" } | ConvertTo-Json
$res = Invoke-RestMethod -Uri http://localhost:5000/api/ingest `
  -Method POST `
  -ContentType "application/json" `
  -Body $body
$res | ConvertTo-Json -Depth 10
```

### 5.3 Query the ingested document

```powershell
$body = @{
  query = "Has Tanaka scored for Leeds United in their FA Cup quarterfinals?"
  endpoint = "ollama"
} | ConvertTo-Json

Invoke-RestMethod -Uri http://localhost:5000/api/invoke-agent `
  -Method POST -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 10
```

The response should include content from the ingested document via `file_search`.

### 5.4 Switch back to AWS Knowledge Base

Change `RAG_SOURCE` back in `webapp\.env`:

```dotenv
RAG_SOURCE=aws
```

Restart the backend. The startup log should show `RAG source: aws`.

---

## 6. Test — Streaming Chat Endpoint

### 6.1 Single-turn request

```powershell
$body = @{
  messages = @(
    @{ role = "user"; content = "Has Tanaka scored for Leeds United in their FA Cup quarterfinals?" }
  )
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Uri http://localhost:5000/api/chat/stream `
  -Method POST `
  -ContentType "application/json" `
  -Body $body
```

`Invoke-RestMethod` collects the SSE stream into a single string. You should see lines like:

```
data: {"choices":[{"delta":{"content":"4"},...}]}
...
data: [DONE]
```

---
