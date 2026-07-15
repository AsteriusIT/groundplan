/** Blueprint-style connected-nodes mark. Inherits color via `currentColor`. */
export function Logo({ className }: Readonly<{ className?: string }>) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="6" y="6" width="7" height="7" rx="1" />
      <rect x="19" y="6" width="7" height="7" rx="1" />
      <rect x="12.5" y="19" width="7" height="7" rx="1" />
      <path d="M9.5 13v2.5h13V13M16 15.5V19" />
    </svg>
  );
}
