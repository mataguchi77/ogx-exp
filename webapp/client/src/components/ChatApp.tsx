import React from 'react';
import { useStreamingChat } from '../hooks/useStreamingChat';
import MessageList from './MessageList';
import InputArea from './InputArea';
import ClearButton from './ClearButton';

/**
 * ChatApp — root component.
 *
 * Owns the useStreamingChat hook and wires state + handlers to all child
 * components. Manages the aria-live completion announcement region:
 * the region is updated exactly once when a stream finishes (not per token).
 *
 * Requirements: 3.1, 8.1, 9.1, 9.4, 9.5, 9.6
 */
function ChatApp(): JSX.Element {
  const {
    messages,
    streamingBuffer,
    isStreaming,
    sendMessage,
    stopStreaming,
    clearConversation,
  } = useStreamingChat();

  // Requirement 9.4 — aria-live announcement fires exactly once per stream completion.
  const [announcement, setAnnouncement] = React.useState('');
  const prevIsStreamingRef = React.useRef(false);

  React.useEffect(() => {
    const prev = prevIsStreamingRef.current;
    if (prev && !isStreaming) {
      // Stream just completed — announce once.
      setAnnouncement('Response complete');
    } else if (!prev && isStreaming) {
      // New stream starting — clear stale announcement.
      setAnnouncement('');
    }
    prevIsStreamingRef.current = isStreaming;
  }, [isStreaming]);

  return (
    <div
      className="chat-app"
      style={{
        // Requirement 3.1 — occupy full viewport
        width: '100vw',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        // Requirement 9.5 — color contrast ≥ 4.5:1
        // Dark text (#1a1a1a) on light background (#f5f5f5) = contrast ~16.8:1
        backgroundColor: '#f5f5f5',
        color: '#1a1a1a',
      }}
    >
      {/*
       * Requirement 9.4 — aria-live="polite" region.
       * Visually hidden but announced by screen readers.
       * Updated exactly once when streaming completes.
       */}
      <div
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: 'absolute',
          width: '1px',
          height: '1px',
          padding: 0,
          margin: '-1px',
          overflow: 'hidden',
          clip: 'rect(0, 0, 0, 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {announcement}
      </div>

      {/* Message history area — fills remaining vertical space */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <MessageList
          messages={messages}
          streamingBuffer={streamingBuffer}
          isStreaming={isStreaming}
        />
      </div>

      {/* Controls row — pinned to the bottom */}
      <div
        className="chat-controls"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          padding: '8px 16px 16px',
          borderTop: '1px solid #d0d0d0',
          backgroundColor: '#f5f5f5',
        }}
      >
        {/* Requirement 9.1 — tab order: Input_Field (1) → Send (2) → Stop (3)
            is enforced inside InputArea via explicit tabIndex props. */}
        <InputArea
          isStreaming={isStreaming}
          onSubmit={sendMessage}
          onStop={stopStreaming}
        />

        <ClearButton onClear={clearConversation} isStreaming={isStreaming} />
      </div>
    </div>
  );
}

export default ChatApp;
