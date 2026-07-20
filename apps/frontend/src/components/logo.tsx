import { cn } from "@/lib/utils";

/**
 * Asterius IT "resource cluster" mark: three overlapping rounded diamonds.
 * Brand colours are fixed (not theme tokens); the `.dark` root class swaps in
 * the on-dark palette, and `isolate` keeps the blend modes inside the mark
 * instead of compositing with whatever surface it sits on.
 */
export function Logo({ className }: Readonly<{ className?: string }>) {
  return (
    <svg viewBox="0 0 100 100" className={cn("isolate", className)} aria-hidden="true">
      <rect
        x="33"
        y="17"
        width="34"
        height="34"
        rx="9"
        transform="rotate(45 50 34)"
        className="fill-[#14b8a6] mix-blend-multiply dark:fill-[#2dd4bf] dark:mix-blend-screen"
      />
      <rect
        x="19"
        y="45"
        width="34"
        height="34"
        rx="9"
        transform="rotate(45 36 62)"
        className="fill-[#0ea5e9] mix-blend-multiply dark:fill-[#38bdf8] dark:mix-blend-screen"
      />
      <rect
        x="47"
        y="45"
        width="34"
        height="34"
        rx="9"
        transform="rotate(45 64 62)"
        className="fill-[#8b5cf6] mix-blend-multiply dark:fill-[#a78bfa] dark:mix-blend-screen"
      />
    </svg>
  );
}
