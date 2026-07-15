/**
 * Snapshot history dropdown. A native-<details> menu (same pattern as
 * ExportMenu) showing the current snapshot in its trigger and every snapshot as
 * a row. Single-select mode picks and closes; compare mode turns rows into
 * checkboxes and keeps the panel open for the two-pick.
 */
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, History } from "lucide-react";

import type { SnapshotSummary } from "@/api/types";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

const shortSha = (sha: string) => sha.slice(0, 8);

/**
 * What identifies a snapshot in the list. A Terraform snapshot is of a commit, so
 * it is named by one; a Kubernetes namespace read (GP-97) is of a moment, and the
 * moment is already in the row beside it — so it says what it is instead of
 * showing eight blank characters where a sha would be.
 */
const snapshotLabel = (snap: SnapshotSummary) =>
  snap.commitSha ? shortSha(snap.commitSha) : "live read";

export function SnapshotSelect({
  snapshots,
  selectedIds,
  visible,
  compareMode,
  onSelect,
  onShowMore,
}: Readonly<{
  snapshots: SnapshotSummary[];
  selectedIds: string[];
  visible: number;
  compareMode: boolean;
  onSelect: (id: string) => void;
  onShowMore: () => void;
}>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDetailsElement>(null);

  // Close on outside click / Escape (native <details> does not do this).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const handleSelect = (id: string) => {
    onSelect(id);
    if (!compareMode) setOpen(false); // keep open for the compare two-pick
  };

  const selected = snapshots.find((s) => selectedIds.includes(s.id)) ?? null;

  const compareLabel = () => {
    if (selectedIds.length === 0) return "Compare — pick 2";
    if (selectedIds.length === 1) return "Pick 1 more";
    return selectedIds
      .map((id) => shortSha(snapshots.find((s) => s.id === id)?.commitSha ?? id))
      .join(" ⇄ ");
  };

  const selectedLabel = () => {
    if (!selected) return "Select snapshot";
    const triggerSuffix = selected.stats.trigger
      ? ` · ${selected.stats.trigger.toUpperCase()}`
      : "";
    return `${snapshotLabel(selected)}${triggerSuffix} · ${formatDate(selected.createdAt)}`;
  };

  const triggerLabel = compareMode ? compareLabel() : selectedLabel();

  return (
    <details ref={ref} open={open} className="relative">
      <summary
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault(); // React state is the single source of open-ness
          setOpen((o) => !o);
        }}
        className={cn(
          buttonVariants({ variant: "outline" }),
          "cursor-pointer list-none font-mono text-xs marker:hidden",
        )}
      >
        <History className="size-4" />
        <span className="text-muted-foreground">History</span>
        <span className="text-ink">{triggerLabel}</span>
        <ChevronDown className="size-4" />
      </summary>
      <div
        role="menu"
        aria-label="Snapshot history"
        className="bg-card border-border absolute right-0 z-20 mt-1 max-h-80 w-72 overflow-y-auto rounded-md border shadow-lg"
      >
        {snapshots.slice(0, visible).map((snap) => {
          const isSelected = selectedIds.includes(snap.id);
          const trigger = snap.stats.trigger;
          return (
            <button
              key={snap.id}
              type="button"
              role={compareMode ? "menuitemcheckbox" : "menuitem"}
              aria-checked={compareMode ? isSelected : undefined}
              aria-current={!compareMode && isSelected ? "true" : undefined}
              onClick={() => handleSelect(snap.id)}
              className={cn(
                "hover:bg-accent flex w-full items-center gap-2 px-3 py-2 text-left transition-colors",
                isSelected && "bg-accent",
              )}
            >
              <span className="flex size-4 shrink-0 items-center justify-center">
                {isSelected && <Check className="text-primary size-3.5" />}
              </span>
              <span className="font-mono text-xs font-medium">
                {snapshotLabel(snap)}
              </span>
              {trigger && (
                <span
                  className={cn(
                    "rounded-xs px-1.5 py-0.5 font-mono text-[9px] uppercase",
                    trigger === "auto"
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {trigger}
                </span>
              )}
              <span className="text-muted-foreground ml-auto font-mono text-[10px]">
                {formatDate(snap.createdAt)}
              </span>
            </button>
          );
        })}
        {snapshots.length > visible && (
          <button
            type="button"
            onClick={onShowMore}
            className="text-muted-foreground hover:text-ink w-full px-3 py-2 text-left text-xs"
          >
            Show more
          </button>
        )}
      </div>
    </details>
  );
}
