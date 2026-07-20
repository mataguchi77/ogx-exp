# Implementation Plan: Frontend Streaming App

## Overview

Backend-first implementation: add `chatRouter.ts` and types to `webapp/server/`, verify them
via CLI, then scaffold the Vite + React + TypeScript client in `webapp/client/`, wire in the
SSE parsing hook and UI components, and finish with property-based and integration tests.

---

## Tasks

- [x] 1. Extend backend types
  - [x] 1.1 Add new types to `webapp/server/src/types.ts`
    - Add `ChatMessage` and `ChatStreamRequestBody` interfaces
    - _Requirements: 2.1_

- [x] 2. Implement `POST /api/chat/stream` (chatRouter)
  - [x] 2.1 Create `webapp/server/src/chatRouter.ts`
    - Export `createChatRouter(fetchFn?)` factory following the `agentRouter` pattern
    - Validate `messages` array (absent / empty / > 100 → HTTP 400)
    - Build OGX payload: `{ model: process.env.OLLAMA_MODEL, messages, stream: true }`; resolve OGX URL from `OGX_BASE_URL`
    - On valid request: forward to `POST /v1/chat/completions`, set `Content-Type: text/event-stream`
      and `Cache-Control: no-cache`, pipe raw SSE bytes to browser without buffering
    - Attach `AbortController`; cancel upstream fetch on `req.on('close', …)`
    - OGX 429 → HTTP 429 with the original OGX error message body (including Request ID) forwarded as JSON error body
    - OGX other non-2xx → HTTP 502; `TypeError` (network) → HTTP 502
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_
  - [x]* 2.2 Write property test: input validation rejects invalid messages arrays
    - **Property 1: Input validation rejects invalid messages arrays**
    - **Validates: Requirements 2.1, 2.4**
    - File: `webapp/server/src/__tests__/chatRouter.test.ts`
    - Generate arrays of length 0 and > 100 → assert HTTP 400
  - [x]* 2.3 Write property test: streaming proxy preserves messages and sets stream flag
    - **Property 2: Streaming proxy preserves messages and sets stream flag**
    - **Validates: Requirements 2.2**
    - File: `webapp/server/src/__tests__/chatRouter.test.ts`
    - Generate valid messages arrays (1–100); mock OGX fetch;
      assert forwarded body has `stream: true`, `messages` equal input, `model` equal `OLLAMA_MODEL`
  - [x]* 2.4 Write unit tests for chatRouter
    - `Content-Type: text/event-stream` and `Cache-Control: no-cache` headers are set
    - Returns HTTP 502 when OGX returns 500
    - Returns HTTP 429 when OGX returns 429, with OGX error body forwarded
    - Returns HTTP 502 when fetch to OGX throws `TypeError`
    - Client disconnect triggers `AbortController.abort()` on upstream fetch
    - File: `webapp/server/src/__tests__/chatRouter.test.ts`
    - _Requirements: 2.3, 2.5, 2.6, 2.7, 2.9_
  - [x]* 2.5 Write property test for HTTP 429 pass-through (Property 13)
    - **Property 13: HTTP 429 from OGX is forwarded as HTTP 429 (not 502)**
    - **Validates: Requirements 2.5, 2.9**
    - File: `webapp/server/src/__tests__/chatRouter.test.ts`
    - Generate OGX 429 responses with error bodies containing random Request IDs (UUID format);
      assert the Streaming_Endpoint returns HTTP 429 and that the response body includes the original OGX error message

- [x] 3. Mount chatRouter in `webapp/server/src/index.ts`
  - Import and mount `createChatRouter` at `/api/chat/stream`
  - Verify existing static-file serving and SPA fallback are untouched
  - _Requirements: 1.5, 2.1_

- [x] 4. Backend checkpoint — verify routes via CLI
  - Ensure all server tests pass: `npx vitest run` in `webapp/server/`
  - Manually smoke-test with PowerShell (see `webapp/docs/backend-testing.md` section 7):
    - `POST http://localhost:5000/api/chat/stream` with a sample messages body → SSE chunks stream back

- [x] 5. Scaffold Vite + React + TypeScript client workspace
  - [x] 5.1 Create the `webapp/client/` Vite project
    - Run `npm create vite@latest client -- --template react-ts` inside `webapp/`
    - Confirm `webapp/package.json` already lists `"client"` in `workspaces`
    - _Requirements: 1.1, 1.2_
  - [x] 5.2 Configure `webapp/client/vite.config.ts`
    - Set `build.outDir: '../server/public'` and `build.emptyOutDir: true`
    - Add dev proxy: `server.proxy['/api'] = 'http://localhost:5000'`
    - _Requirements: 1.4, 1.5_
  - [x] 5.3 Add vitest and @testing-library dependencies to `webapp/client/package.json`
    - Add `vitest`, `@vitest/coverage-v8`, `@testing-library/react`, `@testing-library/user-event`,
      `@testing-library/jest-dom`, `jsdom`, `fast-check`, `@axe-core/react`
    - Add test script: `"test": "vitest run"` and `"test:watch": "vitest"`
  - [x] 5.4 Create `webapp/client/src/types.ts`
    - Define client-side `ChatMessage`, `StreamingState`, `UseStreamingChatReturn` interfaces
    - _Requirements: 4.1, 5.1, 6.2_

- [x] 6. Implement SSE parser utility
  - [x] 6.1 Create `webapp/client/src/utils/sseParser.ts`
    - Export pure function `parseSseLine(line: string): string | null`
    - Parse `data: <json>` lines; extract `choices[0].delta.content`
    - Return `null` for non-`data:` lines, absent/null `delta.content`, `[DONE]`, or malformed JSON
    - _Requirements: 5.2, 5.4_
  - [x]* 6.2 Write property tests for `parseSseLine`
    - **Property 4: Malformed SSE chunks do not corrupt the buffer**
    - **Validates: Requirements 5.4**
    - File: `webapp/client/src/__tests__/sseParser.test.ts`
    - Generate random malformed JSON strings; call `parseSseLine`; assert no throw and `null` returned
    - Also cover Property 3 accumulation via unit test (exact concatenation of delta sequence)

- [x] 7. Implement `useStreamingChat` hook
  - [x] 7.1 Create `webapp/client/src/hooks/useStreamingChat.ts`
    - Manage `messages`, `streamingBuffer`, `isStreaming`, `abortController`
    - `sendMessage`: validate non-blank input; append user message; `POST /api/chat/stream`;
      read `ReadableStream` with `TextDecoder`; call `parseSseLine` per line;
      append delta to buffer; on `[DONE]` commit buffer as assistant message
    - `stopStreaming`: call `abortController.abort()`; commit partial buffer with `isStopped: true`
    - `clearConversation`: reset messages to `[]`; do not call fetch
    - Error handling: HTTP 4xx/5xx, network errors, SSE disconnect without `[DONE]`
      → append `isError: true` message; re-enable controls
    - _Requirements: 4.1–4.7, 5.1–5.6, 6.1–6.6, 7.1–7.6, 8.1–8.6_
  - [-]* 7.2 Write property test: SSE token accumulation is exact concatenation
    - **Property 3: SSE token accumulation is exact concatenation**
    - **Validates: Requirements 5.1, 5.5, 8.2**
    - File: `webapp/client/src/__tests__/useStreamingChat.test.ts`
    - Generate random arrays of delta strings; simulate SSE chunk sequence; assert `buffer === arr.join('')`
  - [-]* 7.3 Write property test: whitespace-only input is rejected
    - **Property 6: Whitespace-only input is rejected**
    - **Validates: Requirements 4.4**
    - File: `webapp/client/src/__tests__/useStreamingChat.test.ts`
    - Generate strings composed entirely of Unicode whitespace; attempt submit;
      assert no fetch called and `messages` unchanged
  - [-]* 7.4 Write property test: full conversation history included in each request
    - **Property 7: Full conversation history included in each request**
    - **Validates: Requirements 4.2, 8.2**
    - File: `webapp/client/src/__tests__/useStreamingChat.test.ts`
    - Generate message histories of length 0–50 plus new input; capture fetch body;
      assert `messages.length === N + 1` and order preserved
  - [-]* 7.5 Write property test: Stop commits partial buffer as "(stopped)"
    - **Property 8: Stop commits partial buffer as "(stopped)"**
    - **Validates: Requirements 6.2, 6.3**
    - File: `webapp/client/src/__tests__/useStreamingChat.test.ts`
    - Generate random partial buffer strings; simulate Stop click;
      assert committed message contains buffer text and "(stopped)" marker
  - [-]* 7.6 Write property test: error responses always re-enable controls
    - **Property 9: Error responses always re-enable controls**
    - **Validates: Requirements 7.5, 4.3**
    - File: `webapp/client/src/__tests__/useStreamingChat.test.ts`
    - Generate HTTP status codes from 4xx/5xx ranges; simulate error; assert controls re-enabled
  - [-]* 7.7 Write property test: HTTP error codes produce visible error entries
    - **Property 10: HTTP error codes produce visible error entries**
    - **Validates: Requirements 7.1, 7.2, 7.6**
    - File: `webapp/client/src/__tests__/useStreamingChat.test.ts`
    - Generate HTTP status codes from 4xx/5xx ranges; assert new `Message_List` entry has `isError: true`
      and renders with a visible error label
  - [ ]* 7.8 Write property test for HTTP 429 client error display (Property 14)
    - **Property 14: HTTP 429 from backend produces a rate-limit error entry with Request ID**
    - **Validates: Requirements 7.7**
    - File: `webapp/client/src/__tests__/useStreamingChat.test.ts`
    - Generate HTTP 429 responses with error bodies containing random Request IDs (UUID format);
      assert the new Message_List entry has `isError: true`, contains the phrase "Too many requests",
      and includes the Request ID from the error body

- [x] 8. Implement React UI components
  - [x] 8.1 Create `webapp/client/src/components/MessageItem.tsx`
    - Render a single `ChatMessage`; right-align `role === 'user'`; left-align assistant/error
    - Apply distinct CSS class for `isError`, `isStopped`, `isIncomplete`
    - _Requirements: 3.2, 3.3, 7.6_
  - [x]* 8.2 Write property test for MessageItem alignment
    - **Property 5: Message alignment by role**
    - **Validates: Requirements 3.2**
    - File: `webapp/client/src/__tests__/MessageItem.test.tsx`
    - Generate `ChatMessage` with `role: 'user'` or `role: 'assistant'`; render `MessageItem`;
      assert correct CSS alignment class
  - [x] 8.3 Create `webapp/client/src/components/MessageList.tsx`
    - Accept `messages`, `streamingBuffer`, `isStreaming` props
    - Render `MessageItem` per completed message; render `StreamingMessageItem` when `streamingBuffer !== null`
    - Auto-scroll to bottom on new message or buffer update unless user manually scrolled up
    - _Requirements: 3.1, 3.3, 3.4, 3.5_
  - [x] 8.4 Create `webapp/client/src/components/InputArea.tsx`
    - Textarea (multi-line, max 4000 chars, expands up to 5 lines); Send button; Stop button
    - Disable textarea and Send when `isStreaming`; enable Stop when `isStreaming`
    - Submit on Enter (no Shift) or Send click; insert newline on Shift+Enter
    - `aria-label="Send message"` on Send; `aria-label="Stop response"` on Stop
    - Associate `<label>` with textarea
    - _Requirements: 3.6, 3.7, 4.1, 4.4, 6.1, 9.2, 9.3, 9.7_
  - [-]* 8.5 Write property test: Enter without Shift submits; Shift+Enter does not
    - **Property 12: Enter without Shift submits; Shift+Enter does not**
    - **Validates: Requirements 9.7**
    - File: `webapp/client/src/__tests__/InputArea.test.tsx`
    - Generate non-empty input strings; simulate Enter (shiftKey: false) → assert `onSubmit` called;
      simulate Enter (shiftKey: true) → assert `onSubmit` NOT called
  - [x] 8.6 Create `webapp/client/src/components/ClearButton.tsx`
    - Calls `onClear` on click; disabled while streaming
    - _Requirements: 8.3, 8.4, 8.5_

- [x] 9. Assemble `ChatApp` root component
  - [x] 9.1 Create `webapp/client/src/components/ChatApp.tsx`
    - Consume `useStreamingChat` hook; pass props to all child components
    - Add `aria-live="polite"` region; update it exactly once on stream completion (not per token)
    - Maintain tab order: Input_Field → Send → Stop (set `tabIndex`)
    - Apply `100vw × 100vh` layout
    - Ensure color-contrast ≥ 4.5:1 and visible focus indicators for all interactive elements
    - _Requirements: 3.1, 8.1, 9.1, 9.4, 9.5, 9.6_
  - [x] 9.2 Create `webapp/client/src/main.tsx` and `webapp/client/src/App.tsx`
    - `App.tsx` re-exports `ChatApp`; `main.tsx` mounts to `#root`
    - _Requirements: 1.1_
  - [ ]* 9.3 Write property test: aria-live completion announcement fires exactly once per stream
    - **Property 11: aria-live completion announcement fires exactly once per stream**
    - **Validates: Requirements 9.4**
    - File: `webapp/client/src/__tests__/ChatApp.test.tsx`
    - Generate sequences of N random delta strings (N ≥ 1) plus `[DONE]`;
      assert `aria-live` region updated exactly once
  - [ ]* 9.4 Write unit tests for ChatApp
    - All required UI elements render (MessageList, InputArea, ClearButton)
    - Send and Input_Field disabled while streaming; re-enabled after
    - Stop button enabled while streaming; disabled when idle
    - `aria-label` values on Send and Stop match spec
    - Input textarea has associated label
    - Clear conversation resets messages; does not call fetch
    - Clear button disabled while streaming
    - Unexpected SSE stream close marks message as `isIncomplete: true`
    - `[DONE]` signal commits buffer as final assistant message
    - Blinking cursor indicator present while streaming; absent when done
    - File: `webapp/client/src/__tests__/ChatApp.test.tsx`
    - _Requirements: 3.3, 3.4, 3.7, 4.3, 6.1, 6.5, 8.3, 8.5, 9.3, 9.5, 9.2, 9.3_

- [x] 10. Add global styles and accessibility polish
  - [x] 10.1 Create `webapp/client/src/index.css`
    - `html, body, #root` → `height: 100%; margin: 0`
    - Streaming indicator: blinking cursor animation on `StreamingMessageItem`
    - Focus-visible outlines on all interactive elements
    - Color palette satisfying ≥ 4.5:1 contrast for all text and controls
    - _Requirements: 3.4, 9.5, 9.6_

- [x] 11. Final checkpoint — full build and test suite
  - Run `npx vitest run` in `webapp/server/` — all server tests pass
  - Run `npx vitest run` in `webapp/client/` — all client tests pass
  - Run `npm run build` from `webapp/` — `webapp/server/public/index.html` exists
  - Run `npm run dev` from `webapp/` (user runs this manually) — both dev servers start concurrently

---

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP.
- The implementation language throughout is **TypeScript** (server: ESM Node.js; client: Vite + React).
- `chatRouter.ts` should mirror the `AbortController` pattern already used in `agentRouter.ts`.
- The model is resolved server-side from `process.env.OLLAMA_MODEL` — there is no client-side model selector.
- `webapp/package.json` already declares `"client"` in `workspaces` and the `dev`/`build` scripts;
  no workspace changes are needed beyond scaffolding the `webapp/client/` directory.
- All property tests use `fast-check` with `{ numRuns: 100 }` and carry a tag comment:
  `// Feature: frontend-streaming-app, Property N: <property text>`
- The Vite `build.outDir` is set to `'../server/public'`, so `npm run build` from `webapp/`
  automatically writes the production bundle where Express serves static files.
- PowerShell smoke-test for the streaming endpoint (see also `webapp/docs/backend-testing.md` §7):
  ```powershell
  $body = @{ messages = @(@{ role = "user"; content = "Hello" }) } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/chat/stream `
    -ContentType "application/json" -Body $body
  ```

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "2.5", "3"] },
    { "id": 3, "tasks": ["5.1", "5.2", "5.3", "5.4"] },
    { "id": 4, "tasks": ["6.1", "7.1", "8.1", "8.3", "8.4", "8.6"] },
    { "id": 5, "tasks": ["6.2", "7.2", "7.3", "7.4", "7.5", "7.6", "7.7", "7.8", "8.2", "8.5"] },
    { "id": 6, "tasks": ["9.1", "9.2", "10.1"] },
    { "id": 7, "tasks": ["9.3", "9.4"] }
  ]
}
```
