import { useEffect, useRef, useCallback } from 'react';
import type { ChatMessage } from '../types';
import MessageItem from './MessageItem';

interface MessageListProps {
  messages: ChatMessage[];
  streamingBuffer: string | null; // null = no active stream
  isStreaming: boolean;
}

interface StreamingMessageItemProps {
  content: string;
  isStreaming: boolean;
}

function StreamingMessageItem({ content, isStreaming }: StreamingMessageItemProps): JSX.Element {
  return (
    <article className="message message-assistant message-streaming">
      <span className="message-content">
        {content}
        {isStreaming && <span className="streaming-cursor" aria-hidden="true" />}
      </span>
    </article>
  );
}

function MessageList({ messages, streamingBuffer, isStreaming }: MessageListProps): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Track whether the user has manually scrolled up
  const userScrolledUpRef = useRef<boolean>(false);

  const handleScroll = useCallback(() => {
    const container = listRef.current;
    if (!container) return;

    const { scrollTop, clientHeight, scrollHeight } = container;
    // Consider the user scrolled up when they are more than 8px from the bottom
    const atBottom = scrollTop + clientHeight >= scrollHeight - 8;
    userScrolledUpRef.current = !atBottom;
  }, []);

  // Auto-scroll when messages change or streaming buffer updates, unless user scrolled up
  useEffect(() => {
    if (!userScrolledUpRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streamingBuffer]);

  return (
    <div
      className="message-list"
      ref={listRef}
      onScroll={handleScroll}
      role="log"
      aria-live="off"
      aria-label="Conversation history"
    >
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} />
      ))}
      {streamingBuffer !== null && (
        <StreamingMessageItem content={streamingBuffer} isStreaming={isStreaming} />
      )}
      <div ref={bottomRef} className="message-list-bottom" aria-hidden="true" />
    </div>
  );
}

export default MessageList;
