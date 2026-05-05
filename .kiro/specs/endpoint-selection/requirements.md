# Requirements Document

## Introduction

This feature allows users to explicitly select which inference endpoint handles their requests — either AWS Bedrock (via the AgentCore MCP gateway) or a local Ollama instance — rather than having OGX automatically decide provider routing. Currently, the webapp always sends requests through OGX using the configured `OLLAMA_MODEL` and attaches the Bedrock AgentCore MCP tool, meaning the routing decision is implicit and opaque to the user. This feature introduces backend API logic and endpoint routing so API consumers can control whether their query is processed by the AWS cloud endpoint or the local Ollama endpoint.

## Glossary

- **Backend**: The Node.js/Express server running on port 5000 at `webapp/server/`
- **OGX**: The API server running on port 8321 that implements OpenAI-compatible APIs and routes inference requests to configured providers
- **Endpoint**: A specific inference provider destination — either AWS Bedrock (via AgentCore MCP gateway) or local Ollama
- **AWS_Endpoint**: The AWS Bedrock AgentCore MCP gateway accessed via the `BEDROCK_AGENT_CORE_GATEWAY_URL` and authenticated with a Cognito OAuth2 token
- **Ollama_Endpoint**: The local Ollama inference server accessed via the `OLLAMA_URL` (default: `http://localhost:11434/v1`)
- **Agent_Router**: The Express router at `webapp/server/src/agentRouter.ts` handling `POST /api/invoke-agent` requests
- **Token_Manager**: The module at `webapp/server/src/tokenManager.ts` that manages Cognito OAuth2 tokens for AWS authentication

## Requirements

### Requirement 1: Endpoint Selection API Parameter

**User Story:** As a user, I want to specify which endpoint handles my request when calling the invoke-agent API, so that I have explicit control over where my query is processed.

#### Acceptance Criteria

1. THE Agent_Router SHALL accept an optional `endpoint` field in the `POST /api/invoke-agent` request body with allowed values `"aws"` and `"ollama"`
2. WHEN the `endpoint` field is omitted or empty, THE Agent_Router SHALL default to `"aws"`
3. IF the `endpoint` field contains a value other than `"aws"` or `"ollama"`, THEN THE Agent_Router SHALL return HTTP 400 with an error message indicating the invalid endpoint value
4. THE Agent_Router SHALL pass the validated endpoint value to the payload builder for routing decisions

### Requirement 2: AWS Endpoint Request Handling

**User Story:** As a user, I want to select the AWS endpoint so that my query is processed by Bedrock AgentCore with full MCP tool access.

#### Acceptance Criteria

1. WHEN the endpoint is `"aws"`, THE Agent_Router SHALL include the MCP tool configuration pointing to the `BEDROCK_AGENT_CORE_GATEWAY_URL` with a valid Cognito bearer token
2. WHEN the endpoint is `"aws"`, THE Agent_Router SHALL use the configured `ollamaModel` as the inference model for OGX (the local model orchestrates the MCP tool calls to AWS)
3. WHEN the endpoint is `"aws"` and the Token_Manager has no valid token, THE Agent_Router SHALL return HTTP 503 with an error indicating the OAuth2 token is unavailable
4. WHEN the endpoint is `"aws"` and a vector store is configured, THE Agent_Router SHALL include the file_search tool in the request

### Requirement 3: Ollama Endpoint Request Handling

**User Story:** As a user, I want to select the Ollama endpoint so that my query is processed entirely by the local Ollama model without calling AWS services.

#### Acceptance Criteria

1. WHEN the endpoint is `"ollama"`, THE Agent_Router SHALL send the request to OGX without the MCP tool configuration (no Bedrock AgentCore tool attached)
2. WHEN the endpoint is `"ollama"`, THE Agent_Router SHALL use the configured `ollamaModel` as the inference model
3. WHEN the endpoint is `"ollama"`, THE Agent_Router SHALL not require a valid Cognito token and SHALL skip token validation
4. WHEN the endpoint is `"ollama"` and a vector store is configured, THE Agent_Router SHALL include the file_search tool in the request

### Requirement 4: Error Handling for Endpoint Failures

**User Story:** As a user, I want clear error messages when my selected endpoint fails, so that I can understand the issue and potentially switch to an alternative endpoint.

#### Acceptance Criteria

1. IF the selected endpoint returns a non-2xx response from OGX, THEN THE Agent_Router SHALL include the endpoint identifier in the error response so the user knows which endpoint failed
2. IF the Ollama endpoint is selected but OGX cannot reach the Ollama server, THEN THE Agent_Router SHALL return HTTP 502 with an error message indicating the Ollama endpoint is unreachable
3. IF the AWS endpoint is selected but the MCP gateway call fails, THEN THE Agent_Router SHALL return HTTP 502 with an error message indicating the AWS endpoint failed
4. THE Agent_Router SHALL not expose internal URLs or credentials in error messages returned to the client
