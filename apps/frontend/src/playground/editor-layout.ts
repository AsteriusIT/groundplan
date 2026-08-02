/**
 * How the Editor is laid out (GP-246): all editor, both, or all diagram.
 *
 * A preference like the sidebar's rail — it belongs to the person and survives
 * a reload — kept beside the split ratio, so coming back to Split finds the
 * divider where it was left rather than in the middle again.
 */
import { useCallback, useEffect, useState } from "react";

export type EditorLayout = "editor" | "split" | "preview";

export const LAYOUT_STORAGE_KEY = "groundplan-playground-layout";
export const SPLIT_STORAGE_KEY = "groundplan-playground-split";

/** How much of the width the editor takes in Split, and its bounds. */
export const SPLIT_MIN = 20;
export const SPLIT_MAX = 80;
export const SPLIT_DEFAULT = 50;

/** The order the shortcut walks: more code → both → more picture → back. */
export const LAYOUT_ORDER: readonly EditorLayout[] = [
  "editor",
  "split",
  "preview",
];

export function clampSplit(percent: number): number {
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Math.round(percent)));
}

function readLayout(): EditorLayout {
  const stored = localStorage.getItem(LAYOUT_STORAGE_KEY);
  return LAYOUT_ORDER.includes(stored as EditorLayout)
    ? (stored as EditorLayout)
    : "split";
}

function readSplit(): number {
  const stored = Number(localStorage.getItem(SPLIT_STORAGE_KEY));
  return Number.isFinite(stored) && stored > 0
    ? clampSplit(stored)
    : SPLIT_DEFAULT;
}

/** A keystroke aimed at text is text, never a window command. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
  );
}

export function useEditorLayout() {
  const [layout, setLayoutState] = useState<EditorLayout>(readLayout);
  const [split, setSplitState] = useState<number>(readSplit);

  const setLayout = useCallback((next: EditorLayout) => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, next);
    setLayoutState(next);
  }, []);

  const setSplit = useCallback((next: number) => {
    const clamped = clampSplit(next);
    localStorage.setItem(SPLIT_STORAGE_KEY, String(clamped));
    setSplitState(clamped);
  }, []);

  // Cmd/Ctrl+Alt+L cycles. Not Ctrl+L (the browser's address bar) and not
  // Ctrl+B (the sidebar's, GP-243) — a shortcut that fights the window it runs
  // in is not a shortcut.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.altKey) return;
      if (event.key.toLowerCase() !== "l" || isTyping(event.target)) return;
      event.preventDefault();
      setLayoutState((current) => {
        const next =
          LAYOUT_ORDER[(LAYOUT_ORDER.indexOf(current) + 1) % LAYOUT_ORDER.length] ??
          "split";
        localStorage.setItem(LAYOUT_STORAGE_KEY, next);
        return next;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return { layout, setLayout, split, setSplit };
}
