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
  -Body '{"model": "llama3.2:1b", "prompt": "hi", "stream": false}'
```

Wait for a response. Subsequent requests will be fast.

## 3. Start the backend (from `webapp\server\`)

```powershell
npm run dev
```

Wait for `Server listening on port 5000`.

## 4. Test

### Check token status

```powershell
Invoke-RestMethod -Uri http://localhost:5000/api/token-info
```

### Send a query

```powershell
$body = @{ query = "What can you help me with?" } | ConvertTo-Json
Invoke-RestMethod -Uri http://localhost:5000/api/invoke-agent `
  -Method POST `
  -ContentType "application/json" `
  -Body $body
```

### Continue a conversation

```powershell
$body = @{
  query     = "Tell me more."
  sessionId = "paste-session-id-from-previous-response"
} | ConvertTo-Json

Invoke-RestMethod -Uri http://localhost:5000/api/invoke-agent `
  -Method POST `
  -ContentType "application/json" `
  -Body $body
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Failed to start: COGNITO_CLIENT_SECRET is required` | Check `webapp\.env` exists and has all four required vars |
| `Failed to acquire initial OAuth2 token` | Verify Cognito credentials in `.env` |
| HTTP 502 | OGX not running — start it with step 1 |
| HTTP 503 | Token refresh failed — check backend logs; retries every 60 s |
| HTTP 504 / gateway timeout | Ollama cold start — run the warmup command in step 2 first |
