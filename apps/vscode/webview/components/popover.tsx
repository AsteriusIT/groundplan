/**
 * A small anchored panel: Escape closes it, a click outside closes it, and it
 * is absent from the document when shut.
 *
 * Hand-rolled rather than pulled from a component library. The webview bundle
 * is size-gated (the `.vsix` must stay under 5 MB and a guard test watches
 * what rides along), the extension ships offline, and what a popover owes its
 * reader here is three behaviours — none of which is worth a dependency.
 */
import { useEffect, useRef } from "react";

import { cn } from "@groundplan/canvas";

export function Popover({
  open,
  onClose,
  label,
  align = "start",
  side = "bottom",
  children,
}: Readonly<{
  open: boolean;
  onClose: () => void;
  /** What this panel is, for anyone who cannot see where it is anchored. */
  label: string;
  align?: "start" | "end";
  /** Which way it opens. The status bar sits at the floor, so it opens up. */
  side?: "top" | "bottom";
  children: React.ReactNode;
}>): React.JSX.Element | null {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    // `mousedown`, not `click`: a control that unmounts on mouseup would
    // otherwise never see the click that dismissed the panel.
    const onPointerDown = (event: MouseEvent): void => {
      if (!panel.current?.contains(event.target as Node)) onClose();
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      className={cn(
        "border-border-strong bg-panel absolute z-30 w-72 rounded-sm border p-3 shadow-lg",
        side === "bottom" ? "top-full mt-1" : "bottom-full mb-1",
        align === "end" ? "right-0" : "left-0",
      )}
    >
      {children}
    </div>
  );
}
