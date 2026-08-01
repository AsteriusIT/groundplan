/**
 * What a keypress in the panel means.
 *
 * A pure function rather than a chain of ifs inside a handler, because the two
 * rules that matter here are easy to get wrong and invisible once buried: the
 * panel must never take a key from a text field, and it must never take one
 * the editor owns. A webview that swallows Ctrl+D breaks a reflex, and the
 * reader has no way to know why.
 */
import type { Lens } from "./panel-state";

export type Shortcut =
  | { kind: "toggleDiff" }
  | { kind: "lens"; lens: Lens }
  | { kind: "fit" }
  | { kind: "search" }
  | { kind: "closePopover" }
  | { kind: "closeSearch" }
  | { kind: "clearSelection" };

export type KeyContext = {
  key: string;
  /** The focus is in a text field: every letter is a letter. */
  typing: boolean;
  popoverOpen: boolean;
  searchOpen: boolean;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
};

const LENS_KEYS: Record<string, Lens> = {
  "1": "infra",
  "2": "network",
  "3": "iam",
};

export function shortcutFor({
  key,
  typing,
  popoverOpen,
  searchOpen,
  ctrl = false,
  meta = false,
  alt = false,
  shift = false,
}: KeyContext): Shortcut | null {
  // Escape first: it is how you get out of the field, so it is the one key
  // that still means something while typing.
  if (key === "Escape") {
    if (popoverOpen) return { kind: "closePopover" };
    if (searchOpen) return { kind: "closeSearch" };
    return { kind: "clearSelection" };
  }

  if (typing) return null;

  // The one modifier binding, because it is the same idea the editor's own
  // Ctrl+F expresses — find, in the thing you are looking at.
  if ((ctrl || meta) && !alt && key.toLowerCase() === "f") {
    return { kind: "search" };
  }

  // Everything else is unmodified only. Ctrl+D is "add selection to next find
  // match"; Cmd+1 is "focus first editor group". Those are not ours to take.
  if (ctrl || meta || alt || shift) return null;

  if (key === "d") return { kind: "toggleDiff" };
  if (key === "f") return { kind: "fit" };
  if (key === "/") return { kind: "search" };

  const lens = LENS_KEYS[key];
  return lens ? { kind: "lens", lens } : null;
}
