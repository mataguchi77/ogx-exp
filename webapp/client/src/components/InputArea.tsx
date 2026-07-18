import { useState, useRef, useEffect } from 'react';

interface InputAreaProps {
  isStreaming: boolean;
  onSubmit: (text: string) => void;
  onStop: () => void;
}

function InputArea({ isStreaming, onSubmit, onStop }: InputAreaProps): JSX.Element {
  const [inputText, setInputText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Dynamically adjust rows (1–5) based on content
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    // Reset to 1 row to get accurate scrollHeight measurement
    el.rows = 1;
    const lineHeight = parseInt(getComputedStyle(el).lineHeight, 10) || 20;
    const padding = parseInt(getComputedStyle(el).paddingTop, 10) +
                    parseInt(getComputedStyle(el).paddingBottom, 10);
    const contentHeight = el.scrollHeight - padding;
    const rows = Math.min(5, Math.max(1, Math.round(contentHeight / lineHeight)));
    el.rows = rows;
  }, [inputText]);

  function handleSubmit() {
    const trimmed = inputText.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setInputText('');
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isStreaming) {
        handleSubmit();
      }
    }
    // Shift+Enter: allow default behaviour (newline insertion)
  }

  return (
    <div className="input-area">
      <label htmlFor="message-input" className="input-label">
        Message
      </label>
      <textarea
        id="message-input"
        ref={textareaRef}
        value={inputText}
        onChange={(e) => setInputText(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={isStreaming}
        maxLength={4000}
        rows={1}
        className="input-textarea"
        placeholder="Type a message…"
        tabIndex={1}
      />
      <button
        type="button"
        aria-label="Send message"
        disabled={isStreaming}
        onClick={handleSubmit}
        className="btn-send"
        tabIndex={2}
      >
        Send
      </button>
      <button
        type="button"
        aria-label="Stop response"
        disabled={!isStreaming}
        onClick={onStop}
        className="btn-stop"
        tabIndex={3}
      >
        Stop
      </button>
    </div>
  );
}

export default InputArea;
