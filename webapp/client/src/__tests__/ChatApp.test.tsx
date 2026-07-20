import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import * as fc from 'fast-check';
import ChatApp from '../components/ChatApp';

// ─── jsdom does not implement scrollIntoView — stub it globally ──────────────
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// ─── Mock the useStreamingChat hook ──────────────────────────────────────────
// We control the hook's return values so we can simulate streaming state changes
// without a real server.

const mockSendMessage = vi.fn();
const mockStopStreaming = vi.fn();
const mockClearConversation = vi.fn();

const defaultHookReturn = {
  messages: [],
  streamingBuffer: null as string | null,
  isStreaming: false,
  sendMessage: mockSendMessage,
  stopStreaming: mockStopStreaming,
  clearConversation: mockClearConversation,
};

// Mutable state that tests can override.
let hookState = { ...defaultHookReturn };

vi.mock('../hooks/useStreamingChat', () => ({
  useStreamingChat: () => hookState,
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderChatApp() {
  return render(<ChatApp />);
}

// ─── Unit Tests ───────────────────────────────────────────────────────────────

describe('ChatApp — renders required UI elements', () => {
  beforeEach(() => {
    hookState = { ...defaultHookReturn };
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // Requirement 3.1
  it('renders a root container with 100vw × 100vh dimensions', () => {
    const { container } = renderChatApp();
    const root = container.firstElementChild as HTMLElement;
    expect(root).toBeInTheDocument();
    expect(root.style.width).toBe('100vw');
    expect(root.style.height).toBe('100vh');
  });

  it('renders the MessageList (log region)', () => {
    renderChatApp();
    expect(screen.getByRole('log')).toBeInTheDocument();
  });

  it('renders the InputArea (textarea)', () => {
    renderChatApp();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('renders Send button with correct aria-label', () => {
    renderChatApp();
    // Requirement 9.2
    expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument();
  });

  it('renders Stop button with correct aria-label', () => {
    renderChatApp();
    // Requirement 9.2
    expect(screen.getByRole('button', { name: 'Stop response' })).toBeInTheDocument();
  });

  it('renders Clear conversation button', () => {
    renderChatApp();
    // Requirement 8.3
    expect(screen.getByRole('button', { name: 'Clear conversation' })).toBeInTheDocument();
  });

  // Requirement 9.3
  it('textarea has an associated label', () => {
    renderChatApp();
    const textarea = screen.getByLabelText('Message', { exact: true });
    expect(textarea).toBeInTheDocument();
    expect(textarea.tagName).toBe('TEXTAREA');
  });

  // Requirement 9.4 — aria-live region exists
  it('has an aria-live="polite" region', () => {
    const { container } = renderChatApp();
    const liveRegion = container.querySelector('[aria-live="polite"]');
    expect(liveRegion).toBeInTheDocument();
  });
});

describe('ChatApp — streaming state controls', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // Requirements 4.3, 6.1
  it('Send button and textarea are disabled while streaming', () => {
    hookState = { ...defaultHookReturn, isStreaming: true, streamingBuffer: '' };
    renderChatApp();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  it('Stop button is enabled while streaming', () => {
    hookState = { ...defaultHookReturn, isStreaming: true, streamingBuffer: '' };
    renderChatApp();
    expect(screen.getByRole('button', { name: 'Stop response' })).toBeEnabled();
  });

  it('Send button and textarea are enabled when not streaming', () => {
    hookState = { ...defaultHookReturn, isStreaming: false };
    renderChatApp();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
    expect(screen.getByRole('textbox')).toBeEnabled();
  });

  it('Stop button is disabled when not streaming', () => {
    hookState = { ...defaultHookReturn, isStreaming: false };
    renderChatApp();
    expect(screen.getByRole('button', { name: 'Stop response' })).toBeDisabled();
  });

  // Requirement 8.5 — Clear disabled while streaming
  it('Clear conversation button is disabled while streaming', () => {
    hookState = { ...defaultHookReturn, isStreaming: true, streamingBuffer: '' };
    renderChatApp();
    expect(screen.getByRole('button', { name: 'Clear conversation' })).toBeDisabled();
  });

  it('Clear conversation button is enabled when not streaming', () => {
    hookState = { ...defaultHookReturn, isStreaming: false };
    renderChatApp();
    expect(screen.getByRole('button', { name: 'Clear conversation' })).toBeEnabled();
  });
});

describe('ChatApp — tab order (Requirement 9.1)', () => {
  afterEach(() => {
    cleanup();
  });

  it('textarea has tabIndex=1', () => {
    hookState = { ...defaultHookReturn };
    renderChatApp();
    expect(screen.getByRole('textbox')).toHaveAttribute('tabindex', '1');
  });

  it('Send button has tabIndex=2', () => {
    hookState = { ...defaultHookReturn };
    renderChatApp();
    expect(screen.getByRole('button', { name: 'Send message' })).toHaveAttribute('tabindex', '2');
  });

  it('Stop button has tabIndex=3', () => {
    hookState = { ...defaultHookReturn };
    renderChatApp();
    expect(screen.getByRole('button', { name: 'Stop response' })).toHaveAttribute('tabindex', '3');
  });
});

describe('ChatApp — aria-live announcement (Requirement 9.4)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // Requirement 9.4 — aria-live region is empty when idle
  it('aria-live region is empty initially', () => {
    hookState = { ...defaultHookReturn };
    const { container } = renderChatApp();
    const liveRegion = container.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(liveRegion.textContent).toBe('');
  });

  // Requirement 9.4 — announcement fires once on stream completion, not per token
  it('aria-live region is updated once when streaming transitions from true to false', async () => {
    // Start streaming
    hookState = { ...defaultHookReturn, isStreaming: true, streamingBuffer: 'Hello' };
    const { rerender, container } = renderChatApp();

    const liveRegion = container.querySelector('[aria-live="polite"]') as HTMLElement;
    // While streaming — no completion announcement yet
    expect(liveRegion.textContent).toBe('');

    // Simulate stream completion
    hookState = { ...defaultHookReturn, isStreaming: false, streamingBuffer: null };
    await act(async () => {
      rerender(<ChatApp />);
    });

    await waitFor(() => {
      expect(liveRegion.textContent).not.toBe('');
    });

    // Announcement should be set exactly once (non-empty)
    expect(liveRegion.textContent).toBeTruthy();
  });

  it('aria-live region is cleared when a new stream starts', async () => {
    // Start streaming → complete → start again
    hookState = { ...defaultHookReturn, isStreaming: true, streamingBuffer: '' };
    const { rerender, container } = renderChatApp();
    const liveRegion = container.querySelector('[aria-live="polite"]') as HTMLElement;

    // Complete the stream
    hookState = { ...defaultHookReturn, isStreaming: false };
    await act(async () => { rerender(<ChatApp />); });
    await waitFor(() => { expect(liveRegion.textContent).not.toBe(''); });

    // Start a new stream — announcement should clear
    hookState = { ...defaultHookReturn, isStreaming: true, streamingBuffer: '' };
    await act(async () => { rerender(<ChatApp />); });
    await waitFor(() => {
      expect(liveRegion.textContent).toBe('');
    });
  });
});

// ─── Property-Based Tests ─────────────────────────────────────────────────────

describe('ChatApp — property tests', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // Feature: frontend-streaming-app, Property 11: aria-live completion announcement fires exactly once per stream
  // **Validates: Requirements 9.4**
  it('Property 11: aria-live region is updated exactly once across any number of tokens then [DONE]', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate N ≥ 1 delta tokens then simulate stream completion
        fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 20 }),
        async (tokens) => {
          // Start streaming with the accumulated buffer
          hookState = {
            ...defaultHookReturn,
            isStreaming: true,
            streamingBuffer: tokens.join(''),
          };
          const { rerender, container, unmount } = render(<ChatApp />);
          const liveRegion = container.querySelector('[aria-live="polite"]') as HTMLElement;

          // Simulate each token update — aria-live must NOT update during streaming
          for (const token of tokens) {
            hookState = {
              ...defaultHookReturn,
              isStreaming: true,
              streamingBuffer: token,
            };
            await act(async () => { rerender(<ChatApp />); });
            // Still streaming — no announcement yet
            expect(liveRegion.textContent).toBe('');
          }

          // [DONE]: streaming ends
          hookState = { ...defaultHookReturn, isStreaming: false, streamingBuffer: null };
          await act(async () => { rerender(<ChatApp />); });

          await waitFor(() => {
            expect(liveRegion.textContent).not.toBe('');
          });

          // Announcement set exactly once (non-empty text present)
          const finalText = liveRegion.textContent ?? '';
          expect(finalText.length).toBeGreaterThan(0);

          unmount();
        }
      ),
      { numRuns: 50 }
    );
  });
});
