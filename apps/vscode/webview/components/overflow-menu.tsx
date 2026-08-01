/**
 * The controls that are settings rather than gestures — reached when wanted,
 * not present at all times.
 *
 * Deliberately shallow. An overflow menu is where controls go to be forgotten,
 * so only things a reader changes once belong here: whether the diagram follows
 * the cursor, and what the keyboard can do.
 */
import { MoreHorizontal, Search } from "lucide-react";

import { strings } from "../strings";
import { Popover } from "./popover";

export function OverflowMenu({
  open,
  onToggle,
  onClose,
  followCursor,
  onToggleFollowCursor,
  onSearch,
  children,
}: Readonly<{
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  followCursor: boolean;
  onToggleFollowCursor: () => void;
  /**
   * Present only in the narrow tier, where search has no room to sit in the
   * bar. Folded away is fine; unreachable is not.
   */
  onSearch?: () => void;
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
        {onSearch && (
          <button
            type="button"
            aria-label={strings.search.label}
            onClick={() => {
              onClose();
              onSearch();
            }}
            className="text-foreground hover:bg-accent-soft mb-2 flex w-full items-center gap-2 border-b border-border pb-2 text-xs"
          >
            <Search className="size-3.5" />
            {strings.search.label}
          </button>
        )}
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
