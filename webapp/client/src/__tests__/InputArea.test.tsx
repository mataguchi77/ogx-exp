import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import * as fc from 'fast-check';
import InputArea from '../components/InputArea';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderInputArea(isStreaming = false) {
  const onSubmit = vi.fn();
  const onStop = vi.fn();
  render(<InputArea isStreaming={isStreaming} onSubmit={onSubmit} onStop={onStop} />);
  return { onSubmit, onStop };
}

// ─── Unit Tests ───────────────────────────────────────────────────────────────

describe('InputArea — accessibility', () => {
  // Requirement 9.2
  it('Send button has aria-label="Send message"', () => {
    renderInputArea();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument();
  });

  // Requirement 9.2
  it('Stop button has aria-label="Stop response"', () => {
    renderInputArea();
    expect(screen.getByRole('button', { name: 'Stop response' })).toBeInTheDocument();
  });

  // Requirement 9.3
  it('Textarea has an associated label or aria-label identifying it as message input', () => {
    renderInputArea();
    // The component uses <label htmlFor="message-input"> with text "Message".
    // Use exact match to avoid colliding with the "Send message" button aria-label.
    const textarea = screen.getByLabelText('Message', { exact: true });
    expect(textarea).toBeInTheDocument();
    expect(textarea.tagName).toBe('TEXTAREA');
  });
});

describe('InputArea — streaming state (Requirement 3.7, 6.1, 6.5)', () => {
  it('Send button is disabled when isStreaming is true (Requirement 3.7)', () => {
    renderInputArea(true);
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('Textarea is disabled when isStreaming is true (Requirement 3.7)', () => {
    renderInputArea(true);
    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  it('Stop button is enabled when isStreaming is true (Requirement 6.1)', () => {
    renderInputArea(true);
    expect(screen.getByRole('button', { name: 'Stop response' })).toBeEnabled();
  });

  it('Stop button is disabled when isStreaming is false (Requirement 6.5)', () => {
    renderInputArea(false);
    expect(screen.getByRole('button', { name: 'Stop response' })).toBeDisabled();
  });

  it('Send button is enabled when isStreaming is false', () => {
    renderInputArea(false);
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
  });

  it('Textarea is enabled when isStreaming is false', () => {
    renderInputArea(false);
    expect(screen.getByRole('textbox')).toBeEnabled();
  });
});

describe('InputArea — tab order (Requirement 9.1)', () => {
  it('Textarea has tabIndex=1', () => {
    renderInputArea();
    expect(screen.getByRole('textbox')).toHaveAttribute('tabindex', '1');
  });

  it('Send button has tabIndex=2', () => {
    renderInputArea();
    expect(screen.getByRole('button', { name: 'Send message' })).toHaveAttribute('tabindex', '2');
  });

  it('Stop button has tabIndex=3', () => {
    renderInputArea();
    expect(screen.getByRole('button', { name: 'Stop response' })).toHaveAttribute('tabindex', '3');
  });
});

// ─── Property-Based Tests ─────────────────────────────────────────────────────

describe('InputArea — property tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // Feature: frontend-streaming-app, Property 12: Enter without Shift submits; Shift+Enter does not
  // **Validates: Requirements 9.7**
  it('Property 12: Enter without Shift submits; Shift+Enter does not', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate non-empty strings that are not pure whitespace
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
        async (inputText) => {
          const onSubmit = vi.fn();
          const onStop = vi.fn();
          cleanup();
          const { container, unmount } = render(
            <InputArea isStreaming={false} onSubmit={onSubmit} onStop={onStop} />
          );

          const textarea = within(container).getByRole('textbox');

          // Set value using fireEvent.change (much faster than userEvent.type for property tests)
          fireEvent.change(textarea, { target: { value: inputText } });

          // — Enter without Shift → should submit —
          fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', shiftKey: false });
          expect(onSubmit).toHaveBeenCalledTimes(1);
          expect(onSubmit).toHaveBeenCalledWith(inputText.trim());

          onSubmit.mockClear();

          // Re-set value because Enter clears the field after submit
          fireEvent.change(textarea, { target: { value: inputText } });

          // — Shift+Enter → should NOT submit —
          fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', shiftKey: true });
          expect(onSubmit).not.toHaveBeenCalled();

          unmount();
        }
      ),
      { numRuns: 100 }
    );
  });
});
