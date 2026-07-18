import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as fc from 'fast-check';
import MessageItem from '../components/MessageItem';
import type { ChatMessage } from '../types';

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'test-id',
    role: 'assistant',
    content: 'Hello world',
    ...overrides,
  };
}

// ─── Unit tests ────────────────────────────────────────────────────────────────

describe('MessageItem', () => {
  describe('role-based alignment', () => {
    it('applies message-user class for user role', () => {
      const { container } = render(
        <MessageItem message={makeMessage({ role: 'user' })} />
      );
      expect(container.firstChild).toHaveClass('message-user');
    });

    it('does not apply message-assistant class for user role', () => {
      const { container } = render(
        <MessageItem message={makeMessage({ role: 'user' })} />
      );
      expect(container.firstChild).not.toHaveClass('message-assistant');
    });

    it('applies message-assistant class for assistant role', () => {
      const { container } = render(
        <MessageItem message={makeMessage({ role: 'assistant' })} />
      );
      expect(container.firstChild).toHaveClass('message-assistant');
    });

    it('does not apply message-user class for assistant role', () => {
      const { container } = render(
        <MessageItem message={makeMessage({ role: 'assistant' })} />
      );
      expect(container.firstChild).not.toHaveClass('message-user');
    });
  });

  describe('error state', () => {
    it('applies message-error class when isError is true', () => {
      const { container } = render(
        <MessageItem message={makeMessage({ isError: true })} />
      );
      expect(container.firstChild).toHaveClass('message-error');
    });

    it('renders the ⚠ Error: label when isError is true (Requirement 7.6)', () => {
      render(<MessageItem message={makeMessage({ isError: true })} />);
      expect(screen.getByText(/⚠ Error:/)).toBeInTheDocument();
    });

    it('does not render ⚠ Error: label on normal assistant messages (Requirement 7.6)', () => {
      render(<MessageItem message={makeMessage({ role: 'assistant' })} />);
      expect(screen.queryByText(/⚠ Error:/)).not.toBeInTheDocument();
    });

    it('does not apply message-error class when isError is absent', () => {
      const { container } = render(
        <MessageItem message={makeMessage()} />
      );
      expect(container.firstChild).not.toHaveClass('message-error');
    });
  });

  describe('stopped state', () => {
    it('applies message-stopped class when isStopped is true', () => {
      const { container } = render(
        <MessageItem message={makeMessage({ isStopped: true })} />
      );
      expect(container.firstChild).toHaveClass('message-stopped');
    });

    it('renders (stopped) marker when isStopped is true', () => {
      render(<MessageItem message={makeMessage({ isStopped: true, content: 'partial' })} />);
      expect(screen.getByText('(stopped)', { exact: false })).toBeInTheDocument();
    });

    it('does not render (stopped) marker when isStopped is absent', () => {
      render(<MessageItem message={makeMessage({ content: 'complete' })} />);
      expect(screen.queryByText('(stopped)', { exact: false })).not.toBeInTheDocument();
    });
  });

  describe('incomplete state', () => {
    it('applies message-incomplete class when isIncomplete is true', () => {
      const { container } = render(
        <MessageItem message={makeMessage({ isIncomplete: true })} />
      );
      expect(container.firstChild).toHaveClass('message-incomplete');
    });

    it('does not apply message-incomplete class when isIncomplete is absent', () => {
      const { container } = render(
        <MessageItem message={makeMessage()} />
      );
      expect(container.firstChild).not.toHaveClass('message-incomplete');
    });
  });

  describe('content rendering', () => {
    it('renders the message content', () => {
      render(<MessageItem message={makeMessage({ content: 'Test content here' })} />);
      expect(screen.getByText('Test content here')).toBeInTheDocument();
    });

    it('renders using an article element', () => {
      const { container } = render(<MessageItem message={makeMessage()} />);
      expect(container.firstChild?.nodeName).toBe('ARTICLE');
    });

    it('applies the base message class', () => {
      const { container } = render(<MessageItem message={makeMessage()} />);
      expect(container.firstChild).toHaveClass('message');
    });
  });
});

// ─── Property-based tests ───────────────────────────────────────────────────────

describe('MessageItem property tests', () => {
  // Feature: frontend-streaming-app, Property 5: Message alignment by role
  // Validates: Requirements 3.2
  it('Property 5: user role always gets message-user class; assistant always gets message-assistant', () => {
    fc.assert(
      fc.property(
        fc.record({
          id: fc.uuid(),
          role: fc.constantFrom('user' as const, 'assistant' as const),
          content: fc.string({ minLength: 1 }),
          isError: fc.option(fc.boolean(), { nil: undefined }),
          isStopped: fc.option(fc.boolean(), { nil: undefined }),
          isIncomplete: fc.option(fc.boolean(), { nil: undefined }),
        }),
        (msg) => {
          const { container } = render(<MessageItem message={msg} />);
          const el = container.firstChild as HTMLElement;
          if (msg.role === 'user') {
            expect(el).toHaveClass('message-user');
            expect(el).not.toHaveClass('message-assistant');
          } else {
            expect(el).toHaveClass('message-assistant');
            expect(el).not.toHaveClass('message-user');
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  // Validates: Requirements 3.3, 7.6
  it('error label is present iff isError is true', () => {
    fc.assert(
      fc.property(
        fc.record({
          id: fc.uuid(),
          role: fc.constantFrom('user' as const, 'assistant' as const),
          content: fc.string(),
          isError: fc.boolean(),
        }),
        (msg) => {
          const { container } = render(<MessageItem message={msg} />);
          const label = container.querySelector('.message-error-label');
          if (msg.isError) {
            expect(label).not.toBeNull();
            expect(label?.textContent).toContain('⚠ Error:');
          } else {
            expect(label).toBeNull();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  // Validates: Requirements 3.3
  it('message-error/stopped/incomplete classes match their respective flags', () => {
    fc.assert(
      fc.property(
        fc.record({
          id: fc.uuid(),
          role: fc.constantFrom('user' as const, 'assistant' as const),
          content: fc.string(),
          isError: fc.boolean(),
          isStopped: fc.boolean(),
          isIncomplete: fc.boolean(),
        }),
        (msg) => {
          const { container } = render(<MessageItem message={msg} />);
          const el = container.firstChild as HTMLElement;
          expect(el.classList.contains('message-error')).toBe(msg.isError);
          expect(el.classList.contains('message-stopped')).toBe(msg.isStopped);
          expect(el.classList.contains('message-incomplete')).toBe(msg.isIncomplete);
        }
      ),
      { numRuns: 100 }
    );
  });
});
