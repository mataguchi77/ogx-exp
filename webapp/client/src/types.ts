export interface ChatMessage {
  id: string;             // uuid
  role: 'user' | 'assistant';
  content: string;
  isError?: boolean;      // true → render as error entry
  isStopped?: boolean;    // true → render as "(stopped)"
  isIncomplete?: boolean; // true → SSE disconnected without [DONE]
}

export interface StreamingState {
  messages: ChatMessage[];
  streamingBuffer: string | null;   // null = idle; string = accumulating
  isStreaming: boolean;
  abortController: AbortController | null;
}

export interface UseStreamingChatReturn {
  messages: ChatMessage[];
  streamingBuffer: string | null;
  isStreaming: boolean;
  sendMessage: (text: string) => Promise<void>;
  stopStreaming: () => void;
  clearConversation: () => void;
}
