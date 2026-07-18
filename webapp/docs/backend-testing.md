# Backend Testing Guide

PowerShell commands for testing on Windows Server 2025. Backend runs on `http://localhost:5000`.

---

## 1. Start Ollama and OGX (from the repo root)

```powershell
// If it is not running
ollama serve
// delete the persistent sqllite-vec storage if needed
Remove-Item -Recurse -Force "$env:USERPROFILE\.ogx\bedrock-agentcore-webapp"
// Start OGX
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

## 3. Start the backend (from `webapp\server\`)

```powershell
npm run dev
```

Wait for `Server listening on port 5000`. The startup log shows `RAG source: aws` or `RAG source: ollama` depending on the `RAG_SOURCE` value in `webapp\.env`.

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

## 6. Test — Config Endpoint

```powershell
Invoke-RestMethod -Uri http://localhost:5000/api/config -Method GET |
  ConvertTo-Json -Depth 5
```

Expected response:

```json
{ "defaultModel": "llama3.1:8b" }
```

If `DEFAULT_MODEL` is set in `webapp\.env`, the response reflects that value.

---

## 7. Test — Streaming Chat Endpoint

### 7.1 Single-turn request

```powershell
$body = @{
  messages = @(
    @{ role = "user"; content = "What is 2 + 2?" }
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

### 7.2 Multi-turn request (conversation history)

```powershell
$body = @{
  messages = @(
    @{ role = "user";      content = "My name is Masahiro." }
    @{ role = "assistant"; content = "Nice to meet you, Masahiro!" }
    @{ role = "user";      content = "What is my name?" }
  )
  model = "llama3.1:8b"
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Uri http://localhost:5000/api/chat/stream `
  -Method POST `
  -ContentType "application/json" `
  -Body $body
```

The model should reference "Masahiro" in its reply.

### 7.3 Validation error (empty messages → HTTP 400)

```powershell
$body = @{ messages = @() } | ConvertTo-Json

try {
  Invoke-RestMethod -Uri http://localhost:5000/api/chat/stream `
    -Method POST -ContentType "application/json" -Body $body
} catch {
  $_.Exception.Response.StatusCode.value__   # Expected: 400
  $_.ErrorDetails.Message                    # Expected: { "error": "Failed to process request: ..." }
}
```

### 7.4 Validation error (model too long → HTTP 400)

```powershell
$longModel = "a" * 257
$body = @{
  messages = @(@{ role = "user"; content = "hi" })
  model    = $longModel
} | ConvertTo-Json -Depth 5

try {
  Invoke-RestMethod -Uri http://localhost:5000/api/chat/stream `
    -Method POST -ContentType "application/json" -Body $body
} catch {
  $_.Exception.Response.StatusCode.value__   # Expected: 400
}
```

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| HTTP 502 "OGX endpoint unreachable" | OGX not running | Run `uv run ogx stack run webapp/ogx-config.yaml` and wait for port 8321 |
| HTTP 502 "upstream returned 4xx/5xx" | Model not loaded | Run the Ollama warmup commands in section 2 |
| Empty / no SSE chunks | Ollama still loading | Wait 30–60 s and retry |
| HTTP 400 on `messages` | Request body malformed | Ensure `messages` is a non-empty array with `role` and `content` fields |

---
