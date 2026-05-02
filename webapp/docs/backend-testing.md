# Backend Testing Guide

PowerShell commands for testing on Windows Server 2025. Backend runs on `http://localhost:5000`.

---

## 1. Start OGX (from the repo root)

```powershell
uv run ogx stack run webapp/ogx-config.yaml
```

Wait for `Uvicorn running on http://:8321`.

## 2. Warm up Ollama

The first request loads the model into memory and can take over a minute. Run this once before testing:

```powershell
Invoke-RestMethod -Uri http://localhost:11434/api/generate `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"model": "llama3.1:8b", "prompt": "hi", "stream": false}'
```

Wait for a response. Subsequent requests will be fast.

## 3. Start the backend (from `webapp\server\`)

```powershell
npm run dev
```

Wait for `Server listening on port 5000`.

## 4. Test

### Send a query

```powershell
$body = @{ query = "What is the infrastructure automation defined by AAP?" } | ConvertTo-Json
$res = Invoke-RestMethod -Uri http://localhost:5000/api/invoke-agent `
  -Method POST `
  -ContentType "application/json" `
  -Body $body
$res | ConvertTo-Json -Depth 10
```
