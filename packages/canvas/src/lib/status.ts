/**
 * Canonical change/impact status metadata (GP-28). One table maps each status to
 * its label, badge glyph and token-based Tailwind classes, so the Chip, the
 * StatusBadge, the node card (GP-30) and the detail panel (GP-33) all speak the
 * same visual language and no component picks a raw colour.
 */
import type { ChangeKind } from "../types";

/** The saturated states in the design system. `impacted` (violet) and `exposed`
 * (orange, GP-45) are not plan actions but share the token-driven treatment. */
export type StatusKind = "create" | "update" | "delete" | "impacted" | "exposed";

export interface StatusMeta {
  label: string;
  /** Circular-badge glyph: + create · ~ update · − delete · ! impacted. */
  glyph: string;
  /** Strong text/icon colour. */
  text: string;
  /** Strong solid fill (badges, bars). */
  bg: string;
  /** Soft tint fill (chips, node cards). */
  soft: string;
  /** Border colour. */
  border: string;
}

export const STATUS_META: Record<StatusKind, StatusMeta> = {
  create: {
    label: "Create",
    glyph: "+",
    text: "text-create",
    bg: "bg-create",
    soft: "bg-create-soft",
    border: "border-create",
  },
  update: {
    label: "Update",
    glyph: "~",
    text: "text-update",
    bg: "bg-update",
    soft: "bg-update-soft",
    border: "border-update",
  },
  delete: {
    label: "Delete",
    glyph: "−",
    text: "text-delete",
    bg: "bg-delete",
    soft: "bg-delete-soft",
    border: "border-delete",
  },
  impacted: {
    label: "Impacted",
    glyph: "!",
    text: "text-impacted",
    bg: "bg-impacted",
    soft: "bg-impacted-soft",
    border: "border-impacted",
  },
  exposed: {
    label: "Internet-exposed",
    glyph: "⚠",
    text: "text-exposed",
    bg: "bg-exposed",
    soft: "bg-exposed-soft",
    border: "border-exposed",
  },
};

/** Human label for a plan change kind (noop included; null → em dash). */
export function changeLabel(change: ChangeKind | null): string {
  if (change === null) return "—";
  if (change === "noop") return "No change";
  return STATUS_META[change].label;
}

/** Map a plan `ChangeKind` to a StatusKind, or null for noop/unknown. */
export function statusOf(change: ChangeKind | null): StatusKind | null {
  return change === "create" || change === "update" || change === "delete"
    ? change
    : null;
}
