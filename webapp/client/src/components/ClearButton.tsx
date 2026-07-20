interface ClearButtonProps {
  onClear: () => void;
  isStreaming: boolean;
}

function ClearButton({ onClear, isStreaming }: ClearButtonProps): JSX.Element {
  return (
    <button
      type="button"
      aria-label="Clear conversation"
      disabled={isStreaming}
      onClick={onClear}
      className="btn-clear"
    >
      Clear conversation
    </button>
  );
}

export default ClearButton;
