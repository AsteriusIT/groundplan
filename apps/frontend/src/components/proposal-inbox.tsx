import { useState } from "react";
import { Check, EyeOff, Group, Loader2, Pencil, Sparkles, Type, X } from "lucide-react";

import type { Annotation, AnnotationType } from "@/api/types";
import { AiBadge } from "@/components/ui/ai-badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const TYPE_ICON = {
  group: Group,
  rename: Type,
  hide: EyeOff,
  note: Sparkles,
  link: Sparkles,
} as const;

const TYPE_LABEL: Record<AnnotationType, string> = {
  group: "Groups",
  rename: "Renames",
  hide: "Hidden",
  note: "Notes",
  link: "Logical edges",
};

/** The order a reviewer wants them in: the big structural claims first. */
const ORDER: AnnotationType[] = ["group", "rename", "hide", "link", "note"];

export type ProposalInboxProps = {
  proposals: Annotation[];
  /** Whether the AI layer is on. Absent ⇒ this component is not rendered at all. */
  suggesting: boolean;
  error: string | null;
  /** The last run said nothing new — worth telling the user, or the button lies. */
  emptyRun: boolean;
  onSuggest: () => void;
  onAccept: (id: string) => void;
  onEdit: (id: string, label: string) => void;
  onDismiss: (id: string) => void;
  /** Hovering a proposal lights its anchors on the canvas; null clears it. */
  onPreview: (anchors: string[] | null) => void;
  onClose: () => void;
};

/**
 * The proposal inbox (GP-76).
 *
 * A model's suggestions arrive here and nowhere else. They are never drawn on the
 * diagram — accepting one is what puts it there — because a diagram that quietly
 * contains machine opinions is a diagram you cannot cite.
 *
 * Everything here is one reviewer's decision at a time: accept it, fix the name
 * and accept it, or throw it away. The one bulk action is "Accept all groups",
 * which is the case where a reviewer genuinely has read them all — they are the
 * proposals you skim as a set, because they are a single claim about structure.
 */
export function ProposalInbox({
  proposals,
  suggesting,
  error,
  emptyRun,
  onSuggest,
  onAccept,
  onEdit,
  onDismiss,
  onPreview,
  onClose,
}: ProposalInboxProps) {
  const groups = proposals.filter((p) => p.type === "group");

  return (
    <aside className="border-border bg-card flex w-80 shrink-0 flex-col overflow-y-auto border-l">
      <header className="border-border flex items-start justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="font-display flex items-center gap-1.5 text-sm font-semibold">
            <Sparkles className="text-primary size-4" />
            Suggested annotations
          </h2>
          <p className="text-muted-foreground mt-0.5 text-xs">
            AI-generated. Nothing here changes the diagram until you accept it.
          </p>
        </div>
        <button
          type="button"
          aria-label="Close suggestions"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground grid size-6 shrink-0 place-items-center rounded"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="border-border flex items-center gap-2 border-b px-4 py-2.5">
        <Button size="sm" onClick={onSuggest} disabled={suggesting}>
          {suggesting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Sparkles className="size-3.5" />
          )}
          {suggesting ? "Thinking…" : "Suggest annotations"}
        </Button>
        {groups.length > 1 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => groups.forEach((g) => onAccept(g.id))}
          >
            Accept all groups
          </Button>
        )}
      </div>

      {error && (
        <p role="alert" className="text-destructive px-4 py-3 text-xs">
          {error}
        </p>
      )}

      {proposals.length === 0 && !error && (
        <p className="text-muted-foreground px-4 py-6 text-center text-xs">
          {emptyRun
            ? "Nothing new to suggest — the model had no groupings to add beyond what is already here."
            : "No suggestions yet. Ask, and they will appear here for review."}
        </p>
      )}

      <ul className="min-h-0 flex-1 divide-y divide-border">
        {ORDER.filter((type) => proposals.some((p) => p.type === type)).map((type) => (
          <li key={type}>
            <p className="text-muted-foreground bg-muted/50 px-4 py-1.5 font-mono text-[10px] tracking-[0.14em] uppercase">
              {TYPE_LABEL[type]} ({proposals.filter((p) => p.type === type).length})
            </p>
            <ul>
              {proposals
                .filter((p) => p.type === type)
                .map((proposal) => (
                  <ProposalRow
                    key={proposal.id}
                    proposal={proposal}
                    onAccept={() => onAccept(proposal.id)}
                    onEdit={(label) => onEdit(proposal.id, label)}
                    onDismiss={() => onDismiss(proposal.id)}
                    onPreview={onPreview}
                  />
                ))}
            </ul>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function ProposalRow({
  proposal,
  onAccept,
  onEdit,
  onDismiss,
  onPreview,
}: {
  proposal: Annotation;
  onAccept: () => void;
  onEdit: (label: string) => void;
  onDismiss: () => void;
  onPreview: (anchors: string[] | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(proposal.label ?? "");
  const Icon = TYPE_ICON[proposal.type];

  const save = () => {
    const label = draft.trim();
    if (!label) return;
    // Edit-then-accept is one action, not two: you fixed the name *because* you
    // are keeping it.
    onEdit(label);
    setEditing(false);
  };

  return (
    <li
      // Hovering a proposal lights its anchors on the canvas — the fastest way to
      // answer "which resources are these, actually".
      onMouseEnter={() => onPreview(proposal.anchors)}
      onMouseLeave={() => onPreview(null)}
      className="hover:bg-accent/40 px-4 py-2.5 transition-colors"
    >
      <div className="flex items-start gap-2">
        <Icon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              aria-label="Edit label"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") setEditing(false);
              }}
              className="border-border w-full rounded border bg-transparent px-1.5 py-0.5 text-xs outline-none"
            />
          ) : (
            <p className="flex items-center gap-1.5 text-xs font-medium">
              <span className="truncate">{proposal.label ?? "Hide"}</span>
              <AiBadge />
            </p>
          )}

          {proposal.reason && (
            <p className="text-muted-foreground mt-0.5 text-[11px] leading-snug">
              {proposal.reason}
            </p>
          )}

          <ul className="mt-1 space-y-0.5">
            {proposal.anchors.map((anchor) => (
              <li key={anchor} className="text-faint truncate font-mono text-[10px]">
                {anchor}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-1.5 pl-5">
        {editing ? (
          <RowButton onClick={save} variant="accept" label="Save & accept">
            <Check className="size-3" />
            Save &amp; accept
          </RowButton>
        ) : (
          <RowButton onClick={onAccept} variant="accept" label="Accept">
            <Check className="size-3" />
            Accept
          </RowButton>
        )}
        {proposal.type !== "hide" && !editing && (
          <RowButton onClick={() => setEditing(true)} label="Edit">
            <Pencil className="size-3" />
            Edit
          </RowButton>
        )}
        <RowButton onClick={onDismiss} label="Dismiss">
          <X className="size-3" />
          Dismiss
        </RowButton>
      </div>
    </li>
  );
}

function RowButton({
  onClick,
  label,
  variant = "plain",
  children,
}: {
  onClick: () => void;
  label: string;
  variant?: "accept" | "plain";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors",
        variant === "accept"
          ? "bg-primary text-primary-foreground hover:opacity-90"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
