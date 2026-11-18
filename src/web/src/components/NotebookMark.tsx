export function NotebookMark({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <line x1="5" y1="18.5" x2="11" y2="6.5" />
      <line x1="11.5" y1="18.5" x2="14.5" y2="5.5" />
      <line x1="17.5" y1="18.5" x2="17.5" y2="5" />
    </svg>
  );
}
