/**
 * The controls that are settings rather than gestures — reached when wanted,
 * not present at all times.
 *
 * Deliberately shallow. An overflow menu is where controls go to be forgotten,
 * so only things a reader changes once belong here: whether the diagram follows
 * the cursor, and what the keyboard can do.
 */
import { MoreHorizontal } from "lucide-react";

import { strings } from "../strings";
import { Popover } from "./popover";

export function OverflowMenu({
  open,
  onToggle,
  onClose,
  followCursor,
  onToggleFollowCursor,
  children,
}: Readonly<{
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  followCursor: boolean;
  onToggleFollowCursor: () => void;
  /** Anything else that belongs behind the ⋯ — the shortcut list, so far. */
  children?: React.ReactNode;
}>): React.JSX.Element {
  return (
    <div className="relative flex items-center">
      <button
        type="button"
        aria-label={strings.overflow.label}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={strings.overflow.label}
        onClick={onToggle}
        className="text-muted-foreground hover:text-foreground flex items-center p-1"
      >
        <MoreHorizontal className="size-3.5" />
      </button>

      <Popover open={open} onClose={onClose} label={strings.overflow.label} align="end">
        <label className="text-foreground flex cursor-pointer items-center gap-2 text-xs">
          <input
            type="checkbox"
            className="accent-primary size-3"
            checked={followCursor}
            onChange={onToggleFollowCursor}
          />
          {strings.overflow.followCursor}
        </label>
        <p className="text-muted-foreground mt-1 text-[10px] leading-snug">
          {strings.overflow.followCursorHint}
        </p>
        {children}
      </Popover>
    </div>
  );
}
