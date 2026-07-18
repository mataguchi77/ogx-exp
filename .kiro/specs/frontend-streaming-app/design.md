# Design Document: Frontend Streaming App

## Overview

This document describes the technical design for adding a React.js frontend (`webapp/client/`) to the existing OGX webapp workspace. The application delivers a streaming chat interface that displays AI responses token-by-token using Server-Sent Events (SSE).

### Key Goals

- A Vite + React + TypeScript single-page application in `webapp/client/`
- A new Express proxy route (`POST /api/chat/stream`) that forwards chat requests to OGX's OpenAI-compatible Chat Completions API with `stream: true`; the model is read from the `OLLAMA_MODEL` environment variable server-side
- Real-time token display via SSE with stop/cancel support using `AbortController`
- Full keyboard accessibility with `aria-live` announcements
- Production build: `webapp/client/dist/` written directly to `webapp/server/public/` and served as static files by Express

### Design Decisions

**Vite over Create React App**: Vite provides significantly faster dev server startup and HMR. It is the de-facto standard for new React projects as of 2024 and produces optimized production bundles via Rollup.

**`fetch` + `ReadableStream` over `EventSource`**: The native `EventSource` API does not support `POST` requests or request bodies, which is required here. Using `fetch` with `ReadableStream` reading gives full control over the SSE response, including `AbortController`-based cancellation. The backend pipe approach keeps this transparent to the browser.

**Custom hook (`useStreamingChat`) over Redux/Zustand**: The state for this feature is localized to the chat session and does not need to be shared across multiple unrelated subtrees. A custom hook keeps the logic colocated and testable without introducing a global state library.

**OGX Chat Completions API over Responses API**: The streaming endpoint targets `/v1/chat/completions` (OpenAI-compatible), which is the standard SSE streaming format used by OGX. The Responses API uses a different event schema and is reserved for the existing agent flow.

---

## Architecture

```
Browser (React SPA)
  │
  │  POST /api/chat/stream   (application/json)
  │  GET  /                  (static index.html + assets)
  ▼
Express Backend  (webapp/server/)  :5000
  │  chatRouter.ts       — POST /api/chat/stream (SSE proxy, uses OLLAMA_MODEL env var)
  │  index.ts            — static file serving from public/
  │
  │  POST /v1/chat/completions  (stream: true, SSE)
  ▼
OGX API Server  :8321
```

### Request Flow — Streaming Chat

```
1. User types message → clicks Send (or Enter)
2. useStreamingChat hook appends user message to Message_List state
3. fetch() → POST /api/chat/stream  { messages: [...] }
4. Express chatRouter validates body, builds OGX payload, calls fetch to OGX
5. OGX streams SSE: data: {"choices":[{"delta":{"content":"..."}}]}\n\n
6. Express pipes raw SSE bytes to browser response (no buffering)
7. React reads from fetch response body ReadableStream (TextDecoder)
8. Each SSE line is parsed → delta.content appended to Streaming_Buffer
9. SSE data: [DONE] → buffer committed as final assistant message
10. On error or stop → AbortController.abort() cancels upstream fetch
```

---

## Components and Interfaces

### React Component Tree

```
ChatApp
├── MessageList
│   ├── MessageItem (role: user | assistant | error)
│   └── StreamingMessageItem  (while streaming)
├── InputArea
│   ├── <textarea> (Input_Field)
│   ├── SendButton
│   └── StopButton
└── ClearButton
```

### Component Contracts

#### `ChatApp`

Root component. Owns the `useStreamingChat` hook and passes state + handlers down as props. Manages the `aria-live` announcement region.

```typescript
// No external props — this is the application root
function ChatApp(): JSX.Element
```

#### `MessageList`

Renders the ordered array of `ChatMessage` objects plus the in-progress `StreamingMessageItem`. Auto-scrolls to the bottom unless the user has manually scrolled up.

```typescript
interface MessageListProps {
  messages: ChatMessage[];
  streamingBuffer: string | null;  // null = no active stream
  isStreaming: boolean;
}
function MessageList(props: MessageListProps): JSX.Element
```

#### `MessageItem`

Renders a single completed message. Applies alignment and error styling based on `role` and `isError`.

```typescript
interface MessageItemProps {
  message: ChatMessage;
}
function MessageItem(props: MessageItemProps): JSX.Element
```

#### `InputArea`

Contains the textarea, Send button, and Stop button. Manages the local `inputText` state. Calls `onSubmit` when Enter (no Shift) or Send is clicked.

```typescript
interface InputAreaProps {
  isStreaming: boolean;
  onSubmit: (text: string) => void;
  onStop: () => void;
}
function InputArea(props: InputAreaProps): JSX.Element
```

### Custom Hook: `useStreamingChat`

Encapsulates all streaming state and side effects.

```typescript
interface ChatMessage {
  id: string;             // uuid
  role: 'user' | 'assistant';
  content: string;
  isError?: boolean;      // true → render as error entry
  isStopped?: boolean;    // true → render as "(stopped)"
  isIncomplete?: boolean; // true → SSE disconnected without [DONE]
}

interface UseStreamingChatReturn {
  messages: ChatMessage[];
  streamingBuffer: string | null;
  isStreaming: boolean;
  sendMessage: (text: string) => Promise<void>;
  stopStreaming: () => void;
  clearConversation: () => void;
}

function useStreamingChat(): UseStreamingChatReturn
```

### Backend Route Interfaces

#### `POST /api/chat/stream`

```typescript
// Request body
interface ChatStreamRequest {
  messages: Array<{ role: string; content: string }>;  // 1–100 items
  // model is resolved server-side from OLLAMA_MODEL env var
}

// Success: HTTP 200, Content-Type: text/event-stream, Cache-Control: no-cache
// Streams raw OGX SSE bytes to the client

// Error responses (application/json)
interface ChatStreamError {
  error: string;  // human-readable description
}
// HTTP 400: validation failure
// HTTP 502: OGX non-2xx or network error
```

---

## Data Models

### Client-Side State

```typescript
// Core message type
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isError?: boolean;
  isStopped?: boolean;
  isIncomplete?: boolean;
}

// Hook internal state (not exposed directly)
interface StreamingState {
  messages: ChatMessage[];
  streamingBuffer: string | null;   // null = idle; string = accumulating
  isStreaming: boolean;
  abortController: AbortController | null;
}
```

### SSE Chunk Parsing

The SSE stream from OGX follows the OpenAI chat completions format:

```
data: {"id":"...","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n
data: {"id":"...","choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n\n
data: [DONE]\n\n
```

The parser extracts `choices[0].delta.content` from each `data:` line. Lines that are not prefixed with `data:`, lines where `delta.content` is absent/null, and lines with malformed JSON are silently skipped.

```typescript
// Pure parsing function (exported for unit/property tests)
function parseSseLine(line: string): string | null {
  // Returns delta text or null (skip)
}
```

### Server-Side Types (additions to `types.ts`)

```typescript
export interface ChatMessage {
  role: string;    // 'user' | 'assistant' | 'system'
  content: string;
}

export interface ChatStreamRequestBody {
  messages: ChatMessage[];
}
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OGX_BASE_URL` | `http://localhost:8321` | OGX server base URL used by the streaming proxy |
| `OLLAMA_MODEL` | `ollama/llama3.1:8b` | Model name forwarded to OGX in every chat request |

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Input validation rejects invalid messages arrays

*For any* request to `POST /api/chat/stream` where the `messages` field is absent, an empty array, or an array with more than 100 items, the backend SHALL respond with HTTP 400 and a JSON error body.

**Validates: Requirements 2.1, 2.4**

---

### Property 2: Streaming proxy preserves messages and sets stream flag

*For any* valid `messages` array (1–100 items) sent to `POST /api/chat/stream`, the forwarded OGX request body SHALL contain `stream: true`, a `messages` array equal to the input array, and the `model` field equal to the `OLLAMA_MODEL` environment variable.

**Validates: Requirements 2.2**

---

### Property 3: SSE token accumulation is exact concatenation

*For any* sequence of delta strings received from the SSE stream, the final `Streaming_Buffer` content SHALL equal the concatenation of all received delta strings in order. No token SHALL be dropped, duplicated, or reordered.

**Validates: Requirements 5.1, 5.5, 9.2**

---

### Property 4: Malformed SSE chunks do not corrupt the buffer

*For any* malformed JSON string received as an SSE `data:` payload, the parser SHALL skip the chunk without modifying the existing `Streaming_Buffer` and without throwing an error.

**Validates: Requirements 5.4**

---

### Property 5: Message alignment by role

*For any* `ChatMessage`, if `role === 'user'` the rendered element SHALL carry the CSS class for right-alignment; if `role === 'assistant'` (or `'error'`), it SHALL carry the CSS class for left-alignment.

**Validates: Requirements 3.2**

---

### Property 6: Whitespace-only input is rejected

*For any* string composed entirely of Unicode whitespace characters (spaces, tabs, newlines, etc.), submitting it SHALL NOT append a message to the `Message_List`, SHALL NOT call `POST /api/chat/stream`, and SHALL leave the `Message_List` unchanged.

**Validates: Requirements 4.4**

---

### Property 7: Full conversation history included in each request

*For any* `Message_List` of length N and any new user input text, the `messages` array in the `POST /api/chat/stream` request body SHALL have exactly N + 1 entries: the N prior messages in insertion order followed by the new user message.

**Validates: Requirements 4.2, 9.2**

---

### Property 8: Stop commits partial buffer as "(stopped)"

*For any* non-empty `Streaming_Buffer` content at the time the user clicks Stop, the resulting committed assistant message SHALL contain that exact buffer text and SHALL be visually marked as "(stopped)".

**Validates: Requirements 6.2, 6.3**

---

### Property 9: Error responses always re-enable controls

*For any* error condition (HTTP 4xx, HTTP 5xx, network error, or unexpected SSE disconnect), after the error is handled the `Send_Button` and `Input_Field` SHALL be enabled.

**Validates: Requirements 7.5, 4.3**

---

### Property 10: HTTP error codes produce visible error entries

*For any* HTTP status code in the 4xx or 5xx range returned by the backend in response to `POST /api/chat/stream`, the `Message_List` SHALL contain exactly one new error entry that includes a visible error label absent from normal assistant messages.

**Validates: Requirements 7.1, 7.2, 7.6**

---

### Property 11: aria-live completion announcement fires exactly once per stream

*For any* stream of N tokens (N ≥ 1) followed by a `[DONE]` signal, the `aria-live` region SHALL be updated exactly once (at stream completion), not once per token.

**Validates: Requirements 9.4**

---

### Property 12: Enter without Shift submits; Shift+Enter does not

*For any* non-empty input string in the `Input_Field`, pressing Enter without Shift SHALL submit the message (equivalent to clicking Send). Pressing Shift+Enter with the same content SHALL insert a newline and SHALL NOT submit.

**Validates: Requirements 9.7**

---

### Property 13: HTTP 429 from OGX is forwarded as HTTP 429 (not 502)

*For any* HTTP 429 response returned by OGX to the Streaming_Endpoint, the Streaming_Endpoint SHALL respond to the browser with HTTP 429 (not HTTP 502) and SHALL include the original OGX error message body (including the Request ID) in the JSON error response body.

**Validates: Requirements 2.5, 2.9**

---

### Property 14: HTTP 429 from backend produces a rate-limit error entry with Request ID

*For any* HTTP 429 response received by the Chat_App from the backend, the Message_List SHALL contain exactly one new error entry that includes the phrase "Too many requests" and the Request ID from the error body (when present).

**Validates: Requirements 7.7**

---

## Error Handling

### Backend Error Handling

| Condition | HTTP Status | Response Body |
|---|---|---|
| `messages` absent / empty / > 100 items | 400 | `{ "error": "Failed to process request: ..." }` |
| OGX returns 429 | 429 | `{ "error": "Too many requests: <OGX error message including Request ID>" }` |
| OGX returns other non-2xx | 502 | `{ "error": "Failed to proxy stream: upstream returned <status>" }` |
| Network error connecting to OGX | 502 | `{ "error": "Failed to proxy stream: OGX endpoint unreachable" }` |
| `OGX_BASE_URL` not set | uses default `http://localhost:8321` | — |

The streaming proxy uses an `AbortController` to cancel the upstream OGX fetch when the client closes the connection (`req.on('close', () => controller.abort())`). This mirrors the pattern in `agentRouter.ts`.

### Client Error Handling

| Condition | UI Behavior |
|---|---|
| HTTP 4xx from backend | Inline error message in Message_List; controls re-enabled |
| HTTP 429 from backend | Rate limit error message with Request ID in Message_List; controls re-enabled |
| HTTP 5xx from backend | Inline error message in Message_List; controls re-enabled |
| Network error (fetch throws) | Inline error message in Message_List; controls re-enabled |
| SSE disconnect without `[DONE]` | Message marked `isIncomplete: true`; controls re-enabled |
| User clicks Stop | Buffer committed as `isStopped: true`; controls re-enabled |
| Malformed SSE JSON chunk | Chunk silently skipped; stream continues |

Error entries in the `Message_List` have `isError: true` and render with a distinct error label (e.g., `⚠ Error:`) that does not appear on normal assistant messages.

---

## Testing Strategy

### Property-Based Testing (fast-check)

The existing server workspace already includes `fast-check` and `vitest`. Client-side property tests will use the same stack via `vitest` with `@testing-library/react`.

**Configuration**: Each property test runs a minimum of 100 iterations (`numRuns: 100`).

**Tag format**: Each test is tagged in a comment: `// Feature: frontend-streaming-app, Property N: <property_text>`

#### Server property tests (`webapp/server/src/__tests__/chatRouter.test.ts`)

- **Property 1** — Generate arrays of length 0 and > 100, verify HTTP 400.
- **Property 2** — Generate valid messages arrays; mock OGX; verify forwarded payload has `stream: true`, correct `messages`, and `model` equal to `OLLAMA_MODEL`.
- **Property 13** — Generate OGX 429 responses with error bodies containing a Request ID; verify the Streaming_Endpoint returns HTTP 429 (not 502) with the OGX error message in the JSON body.

#### Client property tests (`webapp/client/src/__tests__/`)

- **Property 3** — Generate random arrays of delta strings; simulate SSE chunk sequence; verify `Streaming_Buffer === arr.join('')`.
- **Property 4** — Generate random malformed JSON strings; call `parseSseLine`; verify no throw and buffer unchanged.
- **Property 5** — Generate `ChatMessage` with `role: 'user'` or `role: 'assistant'`; render `MessageItem`; verify CSS class.
- **Property 6** — Generate strings from the Unicode whitespace category; attempt submit; verify no fetch call and Message_List unchanged.
- **Property 7** — Generate message histories of length 0–50 plus a new input; simulate submit; capture fetch body; verify `messages.length === N + 1` and order preserved.
- **Property 8** — Generate random partial buffer strings; simulate Stop click; verify committed message contains the buffer text and "(stopped)" marker.
- **Property 9** — Generate HTTP status codes from 4xx and 5xx ranges; simulate error response; verify `Send_Button` and `Input_Field` are enabled after handling.
- **Property 10** — Generate HTTP status codes from 4xx and 5xx ranges; verify the new Message_List entry has `isError: true` and renders with a visible error label.
- **Property 11** — Generate sequences of N random delta strings (N ≥ 1) plus `[DONE]`; verify `aria-live` region updates exactly once.
- **Property 12** — Generate non-empty input strings; simulate Enter keydown (shiftKey: false); verify submit called. Simulate Enter (shiftKey: true); verify submit NOT called.
- **Property 14** — Generate HTTP 429 responses with error bodies containing various Request IDs; verify the new Message_List entry includes "Too many requests" and the Request ID.

### Unit / Example Tests

#### Server (`webapp/server/src/__tests__/chatRouter.test.ts`)

- `POST /api/chat/stream` sets `Content-Type: text/event-stream` and `Cache-Control: no-cache` headers
- `POST /api/chat/stream` returns 502 when OGX returns 500
- `POST /api/chat/stream` returns 429 when OGX returns 429, with the OGX error body forwarded
- `POST /api/chat/stream` returns 502 when fetch to OGX throws `TypeError`
- Client disconnect triggers `AbortController.abort()` on the upstream fetch
- Root `GET /` returns 200 with `index.html` (production static serving)

#### Client (`webapp/client/src/__tests__/`)

- `ChatApp` renders all required UI elements (MessageList, InputArea, ClearButton)
- Send_Button and Input_Field are disabled while streaming; re-enabled after
- Stop_Button is enabled while streaming; disabled when idle
- `aria-label` values on Send, Stop buttons match spec
- Input textarea has associated label
- Clear conversation resets Message_List; does not call fetch
- Clear button is disabled while streaming
- Unexpected SSE stream close marks message as `isIncomplete`
- `[DONE]` signal commits buffer as final assistant message
- Blinking cursor indicator present while streaming; absent when done

### Integration Tests

- Build `webapp/client` → verify `dist/index.html` exists (build smoke test)
- End-to-end streaming: start backend, POST to `/api/chat/stream`, receive first SSE chunk

### Accessibility Validation

- Run `axe-core` via `@axe-core/react` in dev mode to surface contrast and ARIA issues
- Manual tab order verification in browser

---

## File Structure

### New Files

```
webapp/
├── client/                          ← new Vite workspace
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── tsconfig.node.json
│   ├── package.json
│   └── src/
│       ├── main.tsx
│       ├── App.tsx                  ← re-exports ChatApp
│       ├── components/
│       │   ├── ChatApp.tsx
│       │   ├── MessageList.tsx
│       │   ├── MessageItem.tsx
│       │   ├── InputArea.tsx
│       │   └── ClearButton.tsx
│       ├── hooks/
│       │   └── useStreamingChat.ts
│       ├── utils/
│       │   └── sseParser.ts         ← parseSseLine (exported for tests)
│       ├── types.ts
│       ├── index.css
│       └── __tests__/
│           ├── ChatApp.test.tsx
│           ├── MessageItem.test.tsx
│           ├── InputArea.test.tsx
│           ├── useStreamingChat.test.ts
│           └── sseParser.test.ts
└── server/
    └── src/
        ├── chatRouter.ts            ← new: POST /api/chat/stream
        ├── index.ts                 ← updated: mount chatRouter + static serving
        ├── types.ts                 ← updated: ChatMessage, ChatStreamRequestBody
        └── __tests__/
            └── chatRouter.test.ts   ← new
```

### Updated Files

- `webapp/package.json` — already has `"client"` in workspaces and `dev`/`build` scripts
- `webapp/server/src/index.ts` — mount `chatRouter`; static serving from `public/` is already present
- `webapp/server/src/types.ts` — add `ChatMessage`, `ChatStreamRequestBody`

### Build Pipeline

```
npm run build -w client
  └─ vite build → webapp/client/dist/

# Copy step (in package.json or a postbuild script):
Copy-Item -Recurse -Force webapp/client/dist/* webapp/server/public/

npm run start -w server
  └─ Express serves webapp/server/public/ as static files
```

The Vite config sets `build.outDir` to `../server/public` so the copy step is implicit:

```typescript
// webapp/client/vite.config.ts
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:5000',
    },
  },
});
```

The dev proxy routes `/api` calls from the Vite dev server (port 5173) to the Express backend (port 5000), matching the production topology.
