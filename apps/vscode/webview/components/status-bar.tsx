/**
 * The thin bar under the diagram: what the diff is measured against, whether
 * the panel has caught up with the editor, and the one notice worth showing.
 *
 * These are the questions a reader asks *about* the diagram rather than of it,
 * so they get their own line instead of floating over the drawing. Dating both
 * sides matters more here than anywhere else in the panel: a diagram read as
 * live when it is a comparison against an old commit is the failure mode this
 * bar exists to prevent.
 */
import { Loader2, Info, TriangleAlert } from "lucide-react";

import { cn } from "@groundplan/canvas";

import { strings } from "../strings";
import type { Notice } from "../state/status-notice";

export type SyncState = {
  value: "rendering" | "synced" | "error";
  message?: string;
};

/** Enough of a commit to recognise it; the rest is noise in a 24px bar. */
const SHORT_SHA = 7;

function Sync({ sync }: Readonly<{ sync: SyncState }>): React.JSX.Element {
  const text =
    sync.value === "rendering"
      ? strings.status.rendering
      : sync.value === "synced"
        ? strings.status.synced
        : (sync.message ?? strings.status.error);

  return (
    <span
      role="status"
      className={cn(
        "flex items-center gap-1",
        sync.value === "error" ? "text-delete" : "text-muted-foreground",
      )}
    >
      {sync.value === "rendering" && <Loader2 className="size-3 animate-spin" />}
      {sync.value === "error" && <TriangleAlert className="size-3" />}
      {/* Said, not just coloured: a dot that changes hue tells a screen reader
          nothing, and tells anyone who cannot separate the two hues nothing. */}
      {text}
    </span>
  );
}

export function StatusBar({
  base,
  sync,
  notice,
  onAbout,
  children,
}: Readonly<{
  /** What the diff is against; null when no diff is running. */
  base: { ref: string | null; sha: string | null } | null;
  sync: SyncState;
  notice: Notice | null;
  onAbout?: () => void;
  /** The right-hand cluster; filled in as its controls arrive. */
  children?: React.ReactNode;
}>): React.JSX.Element {
  return (
    <div
      aria-label={strings.status.label}
      className="border-border bg-panel text-muted-foreground flex shrink-0 items-center gap-3 border-t px-2 py-0.5 font-mono text-[10px]"
    >
      {base && (
        <span className="flex shrink-0 items-center gap-1.5">
          {base.ref && <span className="text-foreground">{base.ref}</span>}
          {base.sha && <span>{base.sha.slice(0, SHORT_SHA)}</span>}
        </span>
      )}

      <Sync sync={sync} />

      {notice && (
        <span className={cn("truncate", notice.warn ? "text-warning" : undefined)}>
          {notice.text}
        </span>
      )}

      {/* `relative`: anything opened from here hangs off this cluster. */}
      <div className="relative ml-auto flex shrink-0 items-center gap-1">
        {children}
        {/* Only offered while there is a diff to explain. */}
        {base && onAbout && (
          <button
            type="button"
            aria-label={strings.status.about}
            title={strings.status.about}
            onClick={onAbout}
            className="hover:text-foreground flex items-center"
          >
            <Info className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
