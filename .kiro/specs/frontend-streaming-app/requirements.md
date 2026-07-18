# Requirements Document

## Introduction

This feature adds a React.js frontend application (`webapp/client`) to the existing OGX webapp workspace. The app provides a chat interface that streams AI responses token-by-token from the OGX backend (OpenAI-compatible Chat Completions and/or Responses API with SSE streaming). Users type a query, submit it, and see the answer appear incrementally in real time — rather than waiting for the full response to arrive.

The frontend lives in `webapp/client/`, is served as static files by the existing Express backend (`webapp/server/`), and connects to the backend's API routes. The Node backend acts as a proxy/middleware layer to the OGX server, keeping OGX credentials out of the browser.

## Glossary

- **Chat_App**: The React.js single-page application built in `webapp/client/`.
- **Backend**: The existing Express server in `webapp/server/` running on `http://localhost:5000`.
- **OGX**: The OGX API server running on `http://localhost:8321`, implementing OpenAI-compatible Responses API and Chat Completions API.
- **Streaming_Endpoint**: A new Express route (`POST /api/chat/stream`) that proxies an OGX Chat Completions request with `stream: true` and pipes the SSE response back to the browser.
- **SSE**: Server-Sent Events — the transport used by OpenAI-compatible streaming APIs (`text/event-stream`).
- **Chat_Message**: A single conversation turn with a `role` (`user` or `assistant`) and a `content` string.
- **Message_List**: The ordered array of Chat_Messages rendered in the conversation view.
- **Streaming_Buffer**: The in-progress assistant reply that accumulates tokens as they arrive before being committed to the Message_List.
- **Send_Button**: The UI button that submits the user's query.
- **Stop_Button**: The UI button that cancels an in-progress streaming response.
- **Input_Field**: The text area where the user types a query.

---

## Requirements

### Requirement 1: React Client Workspace Setup

**User Story:** As a developer, I want a React client workspace at `webapp/client/` that integrates with the existing npm workspace, so that `npm run dev` from `webapp/` starts both the server and the client concurrently.

#### Acceptance Criteria

1. THE Chat_App SHALL be scaffolded as a Vite + React + TypeScript project in `webapp/client/`.
2. THE Chat_App SHALL be registered as the `client` workspace in `webapp/package.json`.
3. WHEN `npm run dev` is executed from `webapp/`, THE Chat_App dev server SHALL start concurrently alongside the Backend dev server.
4. WHEN `npm run build` is executed from `webapp/`, THE Chat_App SHALL produce a production bundle in `webapp/client/dist/` that includes an `index.html` entry point.
5. THE Backend SHALL serve Chat_App static files from `webapp/server/public/` in production; WHEN a browser requests the root path `/`, THE Backend SHALL return HTTP 200 with the `index.html` entry point.

---

### Requirement 2: Backend Streaming Proxy Endpoint

**User Story:** As a developer, I want a streaming proxy endpoint on the Backend that forwards chat requests to OGX with `stream: true`, so that the browser can consume a real-time SSE stream without holding OGX credentials.

#### Acceptance Criteria

1. THE Backend SHALL expose a `POST /api/chat/stream` route that accepts a JSON body containing a `messages` array of 1–100 Chat_Messages.
2. WHEN a valid request is received, THE Streaming_Endpoint SHALL forward the request to OGX `POST /v1/chat/completions` with `stream: true` and `Content-Type: application/json`.
3. THE Streaming_Endpoint SHALL set the response headers `Content-Type: text/event-stream` and `Cache-Control: no-cache`, and pipe OGX SSE chunks directly to the client without buffering the full response.
4. IF the `messages` array is absent, empty, or exceeds 100 items, THEN THE Streaming_Endpoint SHALL return HTTP 400 with a JSON error body indicating the validation failure.
5. IF the OGX server returns a non-2xx status other than 429, THEN THE Streaming_Endpoint SHALL return HTTP 502 with a JSON error body indicating the upstream failure.
6. WHEN the client closes the connection before the stream completes, THE Streaming_Endpoint SHALL abort the upstream OGX fetch request using an AbortController.
7. IF a network error occurs while connecting to OGX, THEN THE Streaming_Endpoint SHALL return HTTP 502 with a JSON error body indicating the endpoint is unreachable.
8. THE Streaming_Endpoint SHALL resolve the OGX base URL from the `OGX_BASE_URL` environment variable (default: `http://localhost:8321`).
9. IF the OGX server returns HTTP 429, THEN THE Streaming_Endpoint SHALL return HTTP 429 (not 502) to the browser with the original OGX error message body forwarded as the JSON error body.

---

### Requirement 3: Chat Interface Layout

**User Story:** As a user, I want a clean chat interface with a message history area, an input field, and send/stop controls, so that I can easily interact with the AI assistant.

#### Acceptance Criteria

1. THE Chat_App SHALL render a layout occupying 100vw × 100vh containing: a Message_List area, an Input_Field, a Send_Button, and a Stop_Button.
2. THE Chat_App SHALL display user messages right-aligned and assistant messages left-aligned in the Message_List.
3. WHILE a streaming response is in progress, THE Chat_App SHALL display the Streaming_Buffer as an in-progress message with a background or border style distinct from completed assistant messages.
4. THE Chat_App SHALL render a blinking cursor or animated indicator at the end of the Streaming_Buffer to signal active streaming; WHEN streaming ends, THE indicator SHALL be removed.
5. THE Message_List SHALL auto-scroll to the bottom when a new message is appended or when the Streaming_Buffer is updated, unless the user has manually scrolled up.
6. THE Input_Field SHALL support multi-line input and expand vertically up to 5 lines (based on line-height) before scrolling internally, with a maximum of 4000 characters.
7. WHILE a streaming response is in progress, THE Send_Button SHALL be disabled and THE Input_Field SHALL be read-only.

---

### Requirement 4: Sending a Message

**User Story:** As a user, I want to type a query and send it to receive a streaming AI response, so that I can have a real-time conversation with the backend model.

#### Acceptance Criteria

1. WHEN the user clicks Send_Button or presses Enter (without Shift), THE Chat_App SHALL append the user's text as a Chat_Message to the Message_List and clear the Input_Field.
2. WHEN a message is submitted, THE Chat_App SHALL send a `POST /api/chat/stream` request to the Backend with the full Message_List as the `messages` body.
3. WHILE a streaming response is in progress, THE Chat_App SHALL disable the Send_Button and the Input_Field to prevent concurrent submissions; WHEN the stream completes or an error occurs, THE Chat_App SHALL re-enable the Send_Button and the Input_Field.
4. IF the Input_Field is empty or contains only whitespace, THEN THE Chat_App SHALL NOT submit a request and SHALL NOT change the Message_List.
5. WHEN the streaming response completes (SSE `[DONE]` signal received), THE Chat_App SHALL commit the completed Streaming_Buffer as a final assistant Chat_Message in the Message_List.
6. WHEN the first token of a streaming response is received, THE Chat_App SHALL display the Streaming_Buffer within 100 ms of receiving that token.
7. IF the stream terminates with a network error or error signal before `[DONE]` is received, THE Chat_App SHALL display an error indication in the Message_List and SHALL NOT commit the partial Streaming_Buffer as an assistant message.

---

### Requirement 5: Streaming Token Display

**User Story:** As a user, I want to see the AI's response appear word-by-word as tokens arrive, so that I know the model is responding and can read content before it finishes.

#### Acceptance Criteria

1. WHEN an SSE chunk containing a `delta.content` value is received, THE Chat_App SHALL append the delta text to the Streaming_Buffer and update the displayed message to reflect the new buffer content.
2. WHEN an SSE line with the format `data: <json>` is received, THE Chat_App SHALL extract `choices[0].delta.content` from the JSON payload; IF `delta.content` is absent or null in the payload, THE Chat_App SHALL skip that chunk without error.
3. IF an SSE line contains `data: [DONE]`, THE Chat_App SHALL finalize the Streaming_Buffer — the displayed message SHALL stop updating and SHALL be rendered as a completed assistant message no longer marked as in-progress.
4. IF an SSE chunk contains a malformed JSON payload, THE Chat_App SHALL skip that chunk without clearing the Streaming_Buffer or showing an error to the user.
5. THE Chat_App SHALL accumulate delta tokens in the order received; THE Streaming_Buffer content SHALL equal the concatenation of all received delta tokens for the current response.
6. IF the SSE stream disconnects without sending `data: [DONE]`, THE Chat_App SHALL mark the current message as incomplete and display it as distinct from a normally completed assistant message.

---

### Requirement 6: Stop / Cancel Streaming

**User Story:** As a user, I want to stop an in-progress streaming response at any time, so that I can redirect the conversation or correct a mistaken query.

#### Acceptance Criteria

1. WHILE a streaming response is in progress, THE Chat_App SHALL display the Stop_Button as enabled, the Send_Button as disabled, and the Input_Field as disabled.
2. WHEN the user clicks Stop_Button, THE Chat_App SHALL close the SSE connection to the Backend and retain whatever text has already been accumulated in the Streaming_Buffer.
3. WHEN the streaming is stopped by the user, THE Chat_App SHALL commit the partial Streaming_Buffer as a final (truncated) assistant Chat_Message and mark it visually as "(stopped)".
4. WHEN the streaming is stopped, THE Chat_App SHALL re-enable the Send_Button and the Input_Field within 100 milliseconds.
5. WHILE no streaming response is in progress, THE Chat_App SHALL display the Stop_Button as disabled.
6. IF the SSE connection has already closed (e.g., the Backend dropped the stream) before the user clicks Stop_Button, WHEN the user clicks Stop_Button THE Chat_App SHALL still commit the accumulated Streaming_Buffer as a truncated assistant Chat_Message marked "(stopped)" and re-enable the Send_Button and Input_Field.

---

### Requirement 7: Error Handling

**User Story:** As a user, I want clear error messages when the backend or model is unavailable, so that I know what went wrong without the app silently failing.

#### Acceptance Criteria

1. IF the Backend returns HTTP 4xx in response to a streaming request, THE Chat_App SHALL display an inline error message in the Message_List indicating the request was rejected.
2. IF the Backend returns HTTP 5xx in response to a streaming request, THE Chat_App SHALL display an inline error message in the Message_List indicating a server error occurred.
3. IF the SSE stream closes unexpectedly before `[DONE]` is received, THE Chat_App SHALL append an error indicator to the Streaming_Buffer text, add the result as a persistent entry in the Message_List, and clear the Streaming_Buffer.
4. IF a network error prevents the request from reaching the Backend, THE Chat_App SHALL display an inline error message in the Message_List indicating a network error was the cause.
5. WHEN an error occurs, THE Chat_App SHALL re-enable the Send_Button and the Input_Field.
6. THE error message displayed in the Message_List SHALL include a visible error label that is absent from normal assistant messages, making it objectively distinguishable.
7. IF the Backend returns HTTP 429, THE Chat_App SHALL display an inline error message in the Message_List indicating the user should wait and retry, including the Request ID from the error body if present.

---

### Requirement 8: Conversation History

**User Story:** As a user, I want the full conversation context to be sent with each message, so that the model can maintain coherent multi-turn dialogue.

#### Acceptance Criteria

1. THE Chat_App SHALL maintain a Message_List in React state; user messages SHALL be appended on submission, and assistant messages SHALL be appended only after the stream completes fully.
2. WHEN a new user message is submitted, THE Chat_App SHALL include all prior Chat_Messages in the `messages` array sent to `POST /api/chat/stream`, preserving insertion order and the `role` field of each message.
3. THE Chat_App SHALL include a "Clear conversation" control that resets the Message_List to empty.
4. WHEN "Clear conversation" is activated, THE Chat_App SHALL NOT send any request to the Backend.
5. WHILE a streaming response is in progress, the "Clear conversation" control SHALL be disabled.
6. IF streaming is interrupted (by error or stop), THE incomplete assistant message SHALL NOT be added to the Message_List, and the "Clear conversation" control SHALL be re-enabled.

---

### Requirement 9: Accessibility

**User Story:** As a user relying on keyboard navigation, I want to interact with the chat interface fully via keyboard, so that the app is usable without a mouse.

#### Acceptance Criteria

1. THE Chat_App SHALL assign tab order such that focus moves in the sequence: Input_Field → Send_Button → Stop_Button.
2. THE Send_Button SHALL have an `aria-label` of "Send message" and the Stop_Button SHALL have an `aria-label` of "Stop response".
3. THE Input_Field SHALL have an associated `<label>` element or `aria-label` identifying it as the message input.
4. WHEN the streaming response completes, THE Chat_App SHALL announce the completion once via an `aria-live` region set to `polite` (the announcement SHALL NOT fire once per token).
5. THE Chat_App SHALL maintain a color-contrast ratio of at least 4.5:1 for all text and interactive elements against their backgrounds.
6. WHEN any interactive element receives keyboard focus, THE Chat_App SHALL display a visible focus indicator (e.g., outline or highlight) on that element.
7. WHEN the Input_Field has focus and the user presses Enter (without Shift), THE Chat_App SHALL submit the message, equivalent to clicking Send_Button.
