# Implementation Plan: Bedrock AgentCore Web App

## Overview

Build the `webapp/` directory in the OGX monorepo: an OGX distribution config, a TypeScript/Express backend that manages Cognito OAuth2 tokens and proxies requests to OGX's Responses API, and a React/Vite frontend chat SPA. All three cooperate on Windows Server 2025 and are wired together by a PowerShell startup script.

Testing uses Vitest for unit and integration tests, and fast-check for property-based tests covering all 12 correctness properties defined in the design.

## Tasks

- [x] 1. Scaffold workspace root and shared configuration files
  - Create `webapp/package.json` as the npm workspaces root with `server` and `client` workspaces and `build`, `start`, `dev` scripts
  - Create `webapp/.env.example` with all required and optional env vars documented
  - Create `webapp/.gitignore` excluding `node_modules/`, `dist/`, `server/public/`, `.env`, `*.db`
  - Create `webapp/ogx-config.yaml` wiring `remote::ollama`, `remote::model-context-protocol`, and `inline::builtin` responses with SQLite storage backends and `server.port: 8321`
  - _Requirements: 1.1, 1.5, 1.6, 6.2_

- [-] 2. Implement TypeScript backend — project setup and shared types
  - Create `webapp/server/package.json` with dependencies (`express`, `dotenv`, `node-fetch`, `uuid`) and devDependencies (`typescript`, `tsx`, `@types/express`, `@types/node`, `@types/uuid`, `vitest`, `fast-check`, `supertest`, `@types/supertest`)
  - Create `webapp/server/tsconfig.json` targeting ES2022 with `module: NodeNext` and `moduleResolution: NodeNext`
  - Create `webapp/server/src/types.ts` defining `AppConfig`, `TokenState`, `InvokeAgentRequest`, `InvokeAgentResponse`, `ContentBlock`, `ImageBlock`, `TokenInfoResponse`, `OgxResponsesRequest`, and `OgxMcpTool` interfaces
  - _Requirements: 1.1, 3.5, 3.6_

- [~] 3. Implement `config.ts` — environment variable loading and validation
  - Write `webapp/server/src/config.ts` that loads `.env` via `dotenv`, reads all eight env vars, applies defaults for optional vars, and exports a `loadConfig(): AppConfig` function
  - `loadConfig` must throw with a message prefixed `"Failed to start:"` if any of the four required vars is absent or empty; it must exit with code 1 when called from `index.ts`
  - The returned `AppConfig` object must never include `cognitoClientSecret` in any serializable form
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 7.1, 7.6_

  - [ ]* 3.1 Write property test for required config startup failure (Property 1)
    - **Property 1: Required config variables cause startup failure**
    - Generate all non-empty subsets of the four required vars with at least one missing or empty using `fc.subarray` and `fc.boolean()`; assert `validateConfig` throws with message prefixed `"Failed to start:"`
    - **Validates: Requirements 1.2, 7.6**

  - [ ]* 3.2 Write property test for client secret not serialized (Property 2 — config half)
    - **Property 2: Client secret and bearer token are never serialized or returned in responses**
    - Generate arbitrary `cognitoClientSecret` strings; assert `JSON.stringify(loadConfig(...))` does not contain the secret value
    - **Validates: Requirements 2.6, 7.1**

- [~] 4. Implement `tokenManager.ts` — Cognito OAuth2 lifecycle
  - Write `webapp/server/src/tokenManager.ts` with a `TokenManager` class that acquires an initial `client_credentials` token on construction, schedules proactive refresh at `Math.floor(expiresIn * 0.8)` seconds, retries failed refreshes up to 3 times with exponential back-off (2 s, 4 s, 8 s), and sets `isValid = false` after exhausting retries
  - Expose `getToken(): string | null` (returns `null` when `isValid === false`) and `getTokenInfo(): TokenInfoResponse` (never includes `accessToken`)
  - Store `accessToken` in memory only; never write it to disk, logs, or any serialized output
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [ ]* 4.1 Write property test for refresh scheduled at ≤80% of expires_in (Property 5)
    - **Property 5: Token refresh is scheduled at or before 80% of expires_in**
    - Generate arbitrary `expiresIn` values with `fc.integer({ min: 60, max: 86400 })`; assert computed refresh delay ≤ `Math.floor(expiresIn * 0.8)`
    - **Validates: Requirements 2.3**

  - [ ]* 4.2 Write property test for token-info never exposes token value (Property 4)
    - **Property 4: Token-info endpoint never exposes the token value**
    - Generate arbitrary `TokenState` instances with `fc.record({ accessToken: fc.string({ minLength: 1 }), ... })`; assert `getTokenInfo()` result contains `expiresAt`, `remainingSeconds`, `scopes` and does NOT contain `accessToken`
    - **Validates: Requirements 2.7**

  - [ ]* 4.3 Write property test for token not in log output (Property 3)
    - **Property 3: Client secret and bearer token never appear in log output**
    - Generate arbitrary secret and token strings; capture all log output during `TokenManager` operations; assert no log record contains the secret or token value
    - **Validates: Requirements 1.3, 7.2**

- [~] 5. Implement `agentRouter.ts` — POST /api/invoke-agent handler
  - Write `webapp/server/src/agentRouter.ts` as an Express `Router` that validates `Content-Type: application/json` (→ 415), validates `query` is present and non-empty (→ 400), validates `query` length ≤ 10,000 chars (→ 400), checks `tokenManager.getToken()` is non-null (→ 503), constructs the OGX Responses API payload with the MCP tool entry, calls `POST /v1/responses` on OGX with a 30 s timeout, extracts text and image content from the OGX response, and returns `InvokeAgentResponse`
  - Generate a UUID v4 `sessionId` when none is provided in the request; echo the provided `sessionId` back in the response
  - Map OGX/gateway 4xx–5xx → HTTP 502; timeout → HTTP 504; unexpected errors → HTTP 500
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 7.4, 7.5_

  - [ ]* 5.1 Write property test for OGX call includes correct MCP tool (Property 7)
    - **Property 7: OGX Responses API call always includes MCP tool with correct server_url and authorization**
    - Generate arbitrary query strings and bearer token values with `fc.string()`; assert constructed payload has `tools[0].type === "mcp"`, `tools[0].server_url === config.gatewayUrl`, and `tools[0].authorization === bearerToken`
    - **Validates: Requirements 3.1, 3.2**

  - [ ]* 5.2 Write property test for session ID round-trip (Property 8)
    - **Property 8: Session ID round-trip**
    - Generate arbitrary UUID session IDs with `fc.uuid()` and query strings; assert response `sessionId` equals request `sessionId`; for requests without `sessionId`, assert response contains a valid UUID v4
    - **Validates: Requirements 3.3, 3.4**

  - [ ]* 5.3 Write property test for successful response structure invariant (Property 9)
    - **Property 9: Successful response structure invariant**
    - Generate arbitrary OGX response payloads with `fc.array(fc.oneof(textBlockArb, imageBlockArb))`; assert response has `success === true`, non-null `content`, non-empty `sessionId`, and each image block has `alt` and `url` populated
    - **Validates: Requirements 3.5, 3.6**

  - [ ]* 5.4 Write property test for gateway error mapped to HTTP 502 (Property 10)
    - **Property 10: Gateway or OGX HTTP errors are mapped to HTTP 502**
    - Generate arbitrary 4xx/5xx status codes with `fc.integer({ min: 400, max: 599 })`; assert server returns HTTP 502 with `success === false` and `error` starting with `"Failed to invoke agent:"`
    - **Validates: Requirements 3.7**

  - [ ]* 5.5 Write property test for query length validation (Property 11)
    - **Property 11: Query length validation rejects oversized inputs**
    - Generate strings longer than 10,000 chars with `fc.string({ minLength: 10001, maxLength: 20000 })`; assert server returns HTTP 400 with `success === false` and `error === "Failed to process request: query exceeds maximum length"`, and OGX is never called
    - **Validates: Requirements 7.5**

  - [ ]* 5.6 Write property test for non-JSON Content-Type rejected with HTTP 415 (Property 12)
    - **Property 12: Non-JSON Content-Type is rejected with HTTP 415**
    - Generate arbitrary non-JSON content type strings with `fc.string().filter(s => s !== "application/json")`; assert server returns HTTP 415 and OGX is never called
    - **Validates: Requirements 7.4**

  - [ ]* 5.7 Write property test for invalid token causes HTTP 503 (Property 6)
    - **Property 6: Invalid token causes HTTP 503 on every invoke-agent request**
    - Set `TokenState.isValid = false`; generate arbitrary valid query strings; assert server returns HTTP 503 with `success === false` and `error === "Failed to process request: OAuth2 token unavailable"`
    - **Validates: Requirements 2.5**

- [~] 6. Implement `tokenInfo.ts` and `index.ts` — entry point and token-info route
  - Write `webapp/server/src/tokenInfo.ts` as an Express `Router` for `GET /api/token-info` that calls `tokenManager.getTokenInfo()` and returns `TokenInfoResponse` (never the token value)
  - Write `webapp/server/src/index.ts` that calls `loadConfig()`, constructs `TokenManager`, acquires the initial token (retrying up to 3 times with 5 s delay, exiting on failure), mounts `agentRouter` and `tokenInfoRouter`, serves `client/dist` (or `public/`) as static files with `express.static`, and starts listening on `config.port`
  - Log resolved gateway URL, Cognito token URL, and Ollama base URL at INFO level on startup — never log the client secret
  - _Requirements: 1.3, 1.4, 2.1, 2.2, 5.1, 7.1, 7.2_

  - [ ]* 6.1 Write property test for secret and token not in HTTP responses (Property 2 — response half)
    - **Property 2: Client secret and bearer token are never serialized or returned in responses**
    - Generate arbitrary secret and token strings; make requests to all endpoints; assert no response body contains the secret or token value
    - **Validates: Requirements 2.6, 7.1**

- [~] 7. Checkpoint — backend unit and property tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Implement React frontend — project setup and shared types
  - Create `webapp/client/package.json` with dependencies (`react`, `react-dom`) and devDependencies (`vite`, `@vitejs/plugin-react`, `typescript`, `@types/react`, `@types/react-dom`)
  - Create `webapp/client/tsconfig.json` targeting ES2020 with `jsx: react-jsx`
  - Create `webapp/client/vite.config.ts` with the `@vitejs/plugin-react` plugin, dev proxy `/api → localhost:5000`, and `build.outDir: '../server/public'`
  - Create `webapp/client/index.html` as the Vite entry HTML
  - Create `webapp/client/src/types.ts` defining `Message`, `InvokeAgentResponse`, `ContentBlock`, and `ImageBlock`
  - _Requirements: 5.1, 5.9_

- [ ] 9. Implement React frontend — components and app logic
  - Write `webapp/client/src/components/InputBar.tsx`: controlled textarea, submit button, loading spinner, disabled state while in-flight, Enter to submit (Shift+Enter for newline), Tab-navigable
  - Write `webapp/client/src/components/MessageBubble.tsx`: renders a single message with user messages right-aligned and assistant messages left-aligned; renders inline images from `content.images` with `alt` text
  - Write `webapp/client/src/components/ChatWindow.tsx`: scrollable list of `MessageBubble` components, auto-scrolls to bottom on new message
  - Write `webapp/client/src/App.tsx`: holds `messages` state, persists `sessionId` in `sessionStorage`, calls `POST /api/invoke-agent`, handles loading state, appends responses and errors to conversation history
  - Write `webapp/client/src/main.tsx`: `ReactDOM.createRoot` mount
  - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 6.3_

- [ ] 10. Implement PowerShell startup script
  - Write `webapp/Start-WebApp.ps1` that reads `webapp/.env`, validates the four required env vars (exits with a non-zero code and a `"Failed to start:"` message if any are missing), starts OGX with `uv run ogx stack run --config webapp/ogx-config.yaml`, runs `npm run build -w client` to produce `server/public/`, starts the TypeScript backend with `npm run start -w server`, and handles `Ctrl+C` to terminate all child processes cleanly
  - Use only native PowerShell and Windows process execution — no WSL or Linux containers
  - _Requirements: 1.1, 6.1, 6.2, 6.5_

- [ ] 11. Final checkpoint — full stack wired together
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Sub-tasks marked with `*` are optional and can be skipped for a faster MVP
- Each task references specific requirements for traceability
- Property tests use Vitest + fast-check and must run a minimum of 100 iterations per property
- Each property test file must include a comment in the format: `// Feature: bedrock-agentcore-web-app, Property <N>: <property_text>`
- The Vite build outputs to `server/public/` so Express can serve the SPA with a single `express.static('public')` call
- The `webapp/` directory is a self-contained npm workspaces root; run `npm install` once from `webapp/` to install all dependencies
- No test files are committed to the repository per the repository-structure guidelines; tests live in `webapp/server/src/__tests__/` and are excluded from the production build
