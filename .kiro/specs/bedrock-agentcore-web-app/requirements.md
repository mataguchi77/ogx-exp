# Requirements Document

## Introduction

This feature adds a simple browser-based chat web application that lets users send natural-language queries to an AWS Bedrock AgentCore Gateway through OGX as the middleware layer. OGX routes each query through its `remote::model-context-protocol` tool runtime provider to reach the gateway, and uses a locally-installed Ollama instance (running on Windows Server 2025 Datacenter) as the inference backend for orchestration. Cognito OAuth2 `client_credentials` tokens are acquired and refreshed automatically by the backend so the browser never handles raw credentials.

The stack is:

```
Browser (Chat UI)
  └─► OGX HTTP API  (localhost:5000)
        ├─ remote::ollama          (localhost:11434 — local inference / orchestration)
        └─ remote::model-context-protocol  (Bedrock AgentCore Gateway MCP endpoint)
              └─ Cognito OAuth2 bearer token  (auto-acquired)
```

---

## Glossary

- **Web_App**: The browser-based single-page chat application delivered by the OGX backend.
- **OGX_Server**: The OGX agentic API server running on Windows Server 2025, listening on the configured port (default 5000).
- **Ollama_Provider**: The `remote::ollama` inference provider configured inside OGX, pointing at the local Ollama HTTP endpoint (`http://localhost:11434/v1`).
- **MCP_Provider**: The `remote::model-context-protocol` tool runtime provider configured inside OGX, connecting to the Bedrock AgentCore Gateway MCP endpoint.
- **AgentCore_Gateway**: The AWS Bedrock AgentCore Gateway that exposes MCP tools (e.g., `multimodal-agent___invoke_bedrock_agent`) over HTTPS.
- **Token_Manager**: The component inside OGX_Server responsible for acquiring and refreshing Cognito OAuth2 bearer tokens.
- **Cognito_IdP**: The Amazon Cognito user pool acting as the OAuth2 authorization server, issuing bearer tokens via the `client_credentials` grant.
- **Chat_Session**: A stateful conversation identified by a `sessionId`, persisted for the duration of a browser session.
- **Token_Info_Endpoint**: The `GET /api/token-info` endpoint that returns non-sensitive metadata about the current OAuth2 token (expiry, scopes) for debugging.
- **Config_File**: The `.env` file (or equivalent environment variable source) that supplies `BEDROCK_AGENT_CORE_GATEWAY_URL`, `COGNITO_TOKEN_URL`, `COGNITO_CLIENT_ID`, `COGNITO_CLIENT_SECRET`, `OLLAMA_URL`, and `PORT` to OGX_Server at startup.
- **MCP_Tool_Call**: A JSON-RPC 2.0 `tools/call` request sent to the AgentCore_Gateway MCP endpoint.
- **Bearer_Token**: The short-lived OAuth2 access token issued by Cognito_IdP and attached as an `Authorization: Bearer <token>` header on every MCP_Tool_Call.

---

## Requirements

### Requirement 1: OGX Server Startup and Configuration

**User Story:** As a system administrator, I want OGX_Server to start up cleanly on Windows Server 2025 using values from the Config_File, so that I do not need to hard-code credentials or URLs in source code.

#### Acceptance Criteria

1. WHEN OGX_Server starts, THE OGX_Server SHALL read `BEDROCK_AGENT_CORE_GATEWAY_URL`, `COGNITO_TOKEN_URL`, `COGNITO_CLIENT_ID`, `COGNITO_CLIENT_SECRET`, `OLLAMA_URL`, and `PORT` from environment variables or the Config_File.
2. IF any of `BEDROCK_AGENT_CORE_GATEWAY_URL`, `COGNITO_TOKEN_URL`, `COGNITO_CLIENT_ID`, or `COGNITO_CLIENT_SECRET` is absent or empty at startup, THEN THE OGX_Server SHALL log an error message prefixed with "Failed to start:" and exit with a non-zero exit code.
3. WHEN OGX_Server starts successfully, THE OGX_Server SHALL log the resolved gateway URL, the Cognito token URL, and the Ollama base URL at INFO level without logging the client secret value.
4. THE OGX_Server SHALL bind to the TCP port specified by the `PORT` environment variable, defaulting to `5000` when `PORT` is not set.
5. THE OGX_Server SHALL register the Ollama_Provider using the `remote::ollama` provider type with `base_url` set to the value of `OLLAMA_URL` (defaulting to `http://localhost:11434/v1`).
6. THE OGX_Server SHALL register the MCP_Provider using the `remote::model-context-protocol` provider type with the AgentCore_Gateway MCP endpoint URL.

---

### Requirement 2: Cognito OAuth2 Token Acquisition and Refresh

**User Story:** As a developer, I want the Token_Manager to handle all OAuth2 token lifecycle operations automatically, so that the browser and API callers never need to manage credentials.

#### Acceptance Criteria

1. WHEN OGX_Server starts, THE Token_Manager SHALL acquire an initial Bearer_Token from Cognito_IdP using the `client_credentials` grant before accepting any inbound requests.
2. IF the initial token acquisition fails, THEN THE Token_Manager SHALL retry the acquisition up to 3 times with a 5-second delay between attempts before logging "Failed to acquire initial OAuth2 token" and exiting.
3. WHILE a Bearer_Token is active, THE Token_Manager SHALL schedule a proactive refresh at 80% of the token's `expires_in` duration so that the token is replaced before it expires.
4. WHEN a Bearer_Token refresh attempt fails, THE Token_Manager SHALL retry up to 3 times with exponential back-off starting at 2 seconds before logging "Failed to refresh OAuth2 token" and marking the token as invalid.
5. WHEN a Bearer_Token is marked invalid, THE Token_Manager SHALL reject inbound MCP_Tool_Call requests with HTTP 503 and the message "Failed to process request: OAuth2 token unavailable" until a valid token is re-acquired.
6. THE Token_Manager SHALL store the client secret exclusively in memory and SHALL NOT write it to disk, logs, or HTTP response bodies.
7. WHEN the Token_Info_Endpoint is called, THE OGX_Server SHALL return the token expiry timestamp, remaining lifetime in seconds, and token scopes, and SHALL NOT return the token value itself.

---

### Requirement 3: MCP Tool Invocation via OGX

**User Story:** As a developer, I want OGX to forward user queries to the AgentCore_Gateway as MCP tool calls, so that the browser only needs to talk to OGX and not directly to AWS.

#### Acceptance Criteria

1. WHEN OGX_Server receives a `POST /api/invoke-agent` request with a `query` field, THE OGX_Server SHALL construct a JSON-RPC 2.0 `tools/call` request targeting the `multimodal-agent___invoke_bedrock_agent` tool on the AgentCore_Gateway.
2. THE OGX_Server SHALL attach the current Bearer_Token as an `Authorization: Bearer <token>` header on every MCP_Tool_Call sent to the AgentCore_Gateway.
3. WHEN a `sessionId` is provided in the `POST /api/invoke-agent` request body, THE OGX_Server SHALL include that `sessionId` in the MCP_Tool_Call `arguments`.
4. WHEN no `sessionId` is provided in the `POST /api/invoke-agent` request body, THE OGX_Server SHALL generate a new unique `sessionId` and include it in the MCP_Tool_Call `arguments`.
5. WHEN the AgentCore_Gateway returns a successful MCP response, THE OGX_Server SHALL extract the text content and return it in the HTTP response body as `{ "success": true, "content": { "text": [...] }, "sessionId": "<id>" }`.
6. WHEN the AgentCore_Gateway response contains image data, THE OGX_Server SHALL include an `images` array in the `content` field of the response, where each entry contains `alt` and `url` fields.
7. IF the AgentCore_Gateway returns an HTTP 4xx or 5xx status, THEN THE OGX_Server SHALL return HTTP 502 to the caller with `{ "success": false, "error": "Failed to invoke agent: <gateway error message>" }`.
8. IF the MCP_Tool_Call does not receive a response within 30 seconds, THEN THE OGX_Server SHALL return HTTP 504 to the caller with `{ "success": false, "error": "Failed to invoke agent: gateway timeout" }`.

---

### Requirement 4: Local Ollama Inference for Orchestration

**User Story:** As a system administrator, I want OGX to use the locally-installed Ollama instance on Windows Server 2025 for LLM orchestration, so that inference does not require an external cloud API key.

#### Acceptance Criteria

1. THE Ollama_Provider SHALL connect to the Ollama HTTP endpoint at the URL specified by `OLLAMA_URL` using the `remote::ollama` provider type.
2. WHEN OGX_Server starts, THE OGX_Server SHALL verify connectivity to the Ollama_Provider by issuing a model-list request and SHALL log the available models at INFO level.
3. IF the Ollama_Provider is unreachable at startup, THEN THE OGX_Server SHALL log "Failed to connect to Ollama: <error>" at WARNING level and continue starting up, deferring the error to the first inference request.
4. WHEN an inference request is routed to the Ollama_Provider, THE Ollama_Provider SHALL forward the request to the local Ollama HTTP endpoint and return the response to OGX_Server within the configured request timeout.
5. WHERE the `OLLAMA_MODEL` environment variable is set, THE OGX_Server SHALL use that model identifier as the default model for Ollama_Provider inference requests.

---

### Requirement 5: Chat Web UI

**User Story:** As an end user, I want a browser-based chat interface served by OGX_Server, so that I can send queries to the Bedrock AgentCore Gateway without using command-line tools.

#### Acceptance Criteria

1. THE OGX_Server SHALL serve the Web_App as a static single-page application at `GET /` on the configured port.
2. WHEN the Web_App loads in the browser, THE Web_App SHALL display a text input field and a submit button for entering queries.
3. WHEN the user submits a query, THE Web_App SHALL send a `POST /api/invoke-agent` request to OGX_Server with the `query` and the current `sessionId` (if one exists).
4. WHILE a query is in flight, THE Web_App SHALL display a loading indicator and disable the submit button to prevent duplicate submissions.
5. WHEN OGX_Server returns a successful response, THE Web_App SHALL append the assistant's text reply to the conversation history displayed on screen.
6. WHEN OGX_Server returns a response containing images, THE Web_App SHALL render each image inline in the conversation history with its `alt` text.
7. WHEN OGX_Server returns an error response, THE Web_App SHALL display the error message in the conversation history without clearing the user's input.
8. THE Web_App SHALL persist the `sessionId` returned by OGX_Server and include it in all subsequent requests within the same browser session, so that the AgentCore_Gateway maintains conversation context.
9. THE Web_App SHALL display the conversation history in chronological order with user messages visually distinguished from assistant messages.
10. THE Web_App SHALL be operable using only a keyboard (tab navigation, Enter to submit) to meet basic accessibility requirements.

---

### Requirement 6: Windows Server 2025 Compatibility

**User Story:** As a system administrator, I want the entire stack to run on Windows Server 2025 Datacenter without requiring WSL or Linux containers, so that I can deploy it on the existing server infrastructure.

#### Acceptance Criteria

1. THE OGX_Server SHALL start and operate correctly on Windows Server 2025 Datacenter using native Windows process execution (PowerShell or CMD).
2. THE OGX_Server SHALL use file paths compatible with the Windows filesystem, including the Config_File path and any local storage paths.
3. THE Web_App SHALL function correctly in current versions of Microsoft Edge and Google Chrome on Windows Server 2025.
4. WHERE Ollama is installed on Windows Server 2025 with at least 60 GB of free disk space available, THE Ollama_Provider SHALL be able to pull and serve models without additional configuration.
5. THE OGX_Server startup script SHALL be provided as a PowerShell `.ps1` file that sets environment variables from the Config_File and starts OGX_Server.

---

### Requirement 7: Security and Credential Handling

**User Story:** As a security-conscious operator, I want credentials to be handled safely throughout the stack, so that secrets are never exposed to the browser or written to persistent storage in plaintext.

#### Acceptance Criteria

1. THE OGX_Server SHALL NOT include `COGNITO_CLIENT_SECRET`, `COGNITO_CLIENT_ID`, or Bearer_Token values in any HTTP response body sent to the browser.
2. THE OGX_Server SHALL NOT log `COGNITO_CLIENT_SECRET` or Bearer_Token values at any log level.
3. THE Web_App SHALL communicate with OGX_Server exclusively over the loopback interface (`localhost`) when both run on the same host, so that credentials in transit are not exposed on the network.
4. THE OGX_Server SHALL validate that the `Content-Type` header of `POST /api/invoke-agent` requests is `application/json` and SHALL return HTTP 415 for requests with other content types.
5. THE OGX_Server SHALL sanitize the `query` field of inbound requests by rejecting inputs exceeding 10,000 characters with HTTP 400 and the message "Failed to process request: query exceeds maximum length".
6. IF the `COGNITO_CLIENT_SECRET` environment variable is not set, THEN THE OGX_Server SHALL refuse to start and SHALL log "Failed to start: COGNITO_CLIENT_SECRET is required".
