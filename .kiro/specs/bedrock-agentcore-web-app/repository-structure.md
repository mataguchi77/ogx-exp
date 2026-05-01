# Repository Structure

This document defines the file layout for the `webapp/` directory that will be committed to the GitHub repository. The goal is the **minimum number of files** needed to run the application on Windows Server 2025.

---

## Guiding Principles

- **Single `npm install`** at the repo root via npm workspaces — no separate installs per package.
- **No generated files committed** — `dist/`, `node_modules/`, `*.js` build output are all `.gitignore`d.
- **No test files** — tests are excluded to keep the repository focused on the application.
- **One `.env` file** at `webapp/` root, shared by both the OGX startup script and the Node backend.
- **OGX config is a single YAML** — no separate build config or template needed.

---

## Full File Tree

```
webapp/                                  # Root of the new application
│
├── .env.example                         # Template — copy to .env and fill in values
├── .gitignore                           # Ignores node_modules/, dist/, .env, *.db
├── package.json                         # Root workspace: defines "server" and "client" workspaces
├── ogx-config.yaml                      # OGX distribution config (ollama + MCP + responses)
├── Start-WebApp.ps1                     # PowerShell startup script for Windows Server 2025
│
├── server/                              # TypeScript Express backend
│   ├── package.json                     # Dependencies: express, dotenv, node-fetch, uuid
│   ├── tsconfig.json                    # Target: ES2022, module: NodeNext
│   └── src/
│       ├── index.ts                     # Entry point: load config → init TokenManager → start Express
│       ├── config.ts                    # Env var loading (dotenv) + startup validation
│       ├── tokenManager.ts              # Cognito OAuth2 lifecycle: acquire, proactive refresh, retry
│       ├── agentRouter.ts               # POST /api/invoke-agent → OGX /v1/responses
│       ├── tokenInfo.ts                 # GET /api/token-info (no token value in response)
│       └── types.ts                     # Shared TypeScript interfaces
│
└── client/                              # React + Vite frontend
    ├── package.json                     # Dependencies: react, react-dom, vite
    ├── tsconfig.json                    # Target: ES2020, JSX: react-jsx
    ├── vite.config.ts                   # Dev proxy: /api/* → localhost:5000
    ├── index.html                       # Vite entry HTML
    └── src/
        ├── main.tsx                     # React root mount
        ├── App.tsx                      # Root component: state, session management
        ├── types.ts                     # Shared types (InvokeAgentResponse, etc.)
        └── components/
            ├── ChatWindow.tsx           # Scrollable conversation history
            ├── MessageBubble.tsx        # Single message bubble (user / assistant)
            └── InputBar.tsx             # Text input + submit button + loading state
```

**Total: 21 files** (excluding generated/ignored files)

---

## File Descriptions

### Root level

| File | Purpose |
|------|---------|
| `.env.example` | Template with all required and optional env vars. Copy to `.env` before first run. |
| `.gitignore` | Excludes `node_modules/`, `dist/`, `public/`, `.env`, `*.db`. |
| `package.json` | npm workspaces root. Scripts: `build`, `start`, `dev`. |
| `ogx-config.yaml` | OGX distribution config wiring `remote::ollama`, `remote::model-context-protocol`, `inline::builtin` responses. |
| `Start-WebApp.ps1` | Loads `.env`, validates required vars, starts OGX + builds client + starts server. |

### `server/src/`

| File | Purpose |
|------|---------|
| `index.ts` | Calls `loadConfig()`, creates `TokenManager`, acquires initial token, mounts Express routes, starts listening. |
| `config.ts` | Reads env vars via `dotenv`, validates required fields (exits with code 1 on failure), returns typed `AppConfig`. |
| `tokenManager.ts` | Acquires Cognito `client_credentials` token on startup; schedules proactive refresh at 80% of `expires_in`; retries with exponential back-off; exposes `getToken()` and `getTokenInfo()`. |
| `agentRouter.ts` | Validates request body, calls `tokenManager.getToken()`, builds OGX Responses API payload with MCP tool entry, calls `POST /v1/responses`, extracts text/image content, returns `InvokeAgentResponse`. |
| `tokenInfo.ts` | Returns `{ expiresAt, remainingSeconds, scopes }` from `tokenManager.getTokenInfo()` — never the token value. |
| `types.ts` | `AppConfig`, `TokenState`, `InvokeAgentRequest`, `InvokeAgentResponse`, `ContentBlock`, `ImageBlock`, `TokenInfoResponse`, `OgxResponsesRequest`. |

### `client/src/`

| File | Purpose |
|------|---------|
| `main.tsx` | `ReactDOM.createRoot` mount. |
| `App.tsx` | Holds `messages` state and `sessionId` in `sessionStorage`. Passes props to `ChatWindow` and `InputBar`. Calls `POST /api/invoke-agent`. |
| `types.ts` | `Message`, `InvokeAgentResponse`, `ContentBlock`, `ImageBlock` — mirrors server types. |
| `components/ChatWindow.tsx` | Renders the list of `MessageBubble` components in a scrollable container. Auto-scrolls to bottom on new message. |
| `components/MessageBubble.tsx` | Renders a single message. User messages right-aligned, assistant left-aligned. Renders inline images from `content.images`. |
| `components/InputBar.tsx` | Controlled textarea + submit button. Disables and shows spinner while request is in flight. Submits on Enter (Shift+Enter for newline). |

---

## Key Configuration Files (content preview)

### `.env.example`

```dotenv
# Required
BEDROCK_AGENT_CORE_GATEWAY_URL=https://your-gateway-id.gateway.bedrock-agentcore.your-region.amazonaws.com/mcp
COGNITO_TOKEN_URL=https://your-domain.auth.your-region.amazoncognito.com/oauth2/token
COGNITO_CLIENT_ID=your_cognito_client_id
COGNITO_CLIENT_SECRET=your_cognito_client_secret

# Optional (defaults shown)
OLLAMA_URL=http://localhost:11434/v1
OLLAMA_MODEL=ollama/llama3.2
OGX_BASE_URL=http://localhost:8321
PORT=5000
```

### Root `package.json`

```json
{
  "name": "bedrock-agentcore-webapp",
  "private": true,
  "workspaces": ["server", "client"],
  "scripts": {
    "build": "npm run build -w client",
    "start": "npm run start -w server",
    "dev":   "concurrently \"npm run dev -w client\" \"npm run dev -w server\""
  },
  "devDependencies": {
    "concurrently": "^9.0.0"
  }
}
```

### `server/package.json`

```json
{
  "name": "bedrock-agentcore-server",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev":   "tsx watch src/index.ts"
  },
  "dependencies": {
    "dotenv":     "^16.4.5",
    "express":    "^4.19.2",
    "node-fetch": "^3.3.2",
    "uuid":       "^10.0.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node":    "^20.14.0",
    "@types/uuid":    "^10.0.0",
    "tsx":            "^4.15.0",
    "typescript":     "^5.5.0"
  }
}
```

### `client/package.json`

```json
{
  "name": "bedrock-agentcore-client",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev":   "vite"
  },
  "dependencies": {
    "react":     "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@types/react":         "^18.3.0",
    "@types/react-dom":     "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript":           "^5.5.0",
    "vite":                 "^5.3.0"
  }
}
```

### `vite.config.ts`

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:5000'   // dev only — prod uses Express static serving
    }
  },
  build: {
    outDir: '../server/public'          // Express serves from server/public/ in prod
  }
})
```

> The Vite build outputs to `server/public/` so Express can serve it with a single
> `express.static('public')` call — no separate static hosting needed.

---

## What is NOT in the repository

| Excluded | Reason |
|----------|--------|
| `node_modules/` | Installed by `npm install` |
| `server/dist/` | Compiled by `tsc` / `npm run build` |
| `server/public/` | Generated by `vite build` |
| `.env` | Contains secrets — use `.env.example` as template |
| `*.db` | OGX SQLite stores — created at runtime by OGX |

---

## Getting Started (after cloning)

```powershell
# 1. Copy and fill in the env file
Copy-Item webapp\.env.example webapp\.env
# Edit webapp\.env with your actual values

# 2. Install all dependencies (root + workspaces)
cd webapp
npm install

# 3. Start everything
.\Start-WebApp.ps1
```

Open `http://localhost:5000` in Edge or Chrome.
