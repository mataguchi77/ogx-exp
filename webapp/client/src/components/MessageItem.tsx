import type { ChatMessage } from '../types';

interface MessageItemProps {
  message: ChatMessage;
}

function MessageItem({ message }: MessageItemProps): JSX.Element {
  const { role, content, isError, isStopped, isIncomplete } = message;

  // Base alignment class by role
  const classes = ['message', role === 'user' ? 'message-user' : 'message-assistant'];

  if (isError) classes.push('message-error');
  if (isStopped) classes.push('message-stopped');
  if (isIncomplete) classes.push('message-incomplete');

  return (
    <article className={classes.join(' ')}>
      {isError && (
        <span className="message-error-label" aria-label="Error indicator">
          ⚠ Error:
        </span>
      )}
      <span className="message-content">
        {content}
        {isStopped && (
          <span className="message-stopped-marker"> (stopped)</span>
        )}
      </span>
    </article>
  );
}

export default MessageItem;
