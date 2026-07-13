import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import { Maximize2, Minimize2 } from "lucide-react";

import { cn } from "@/lib/utils";

type FocusMode = {
  /** True while the diagram owns the viewport. */
  focus: boolean;
  /** False outside the app shell (the public share view), where there is no chrome to hide. */
  available: boolean;
  enter: () => void;
  exit: () => void;
};

const noop = () => {};

const FocusModeContext = createContext<FocusMode>({
  focus: false,
  available: false,
  enter: noop,
  exit: noop,
});

/**
 * Fullscreen ("focus") mode for the diagram pages: the sidebar and the page
 * header step aside so the canvas owns the viewport, leaving only the slim view
 * strip. The state lives in the app shell because the sidebar is a sibling of
 * the page — a page cannot hide it on its own.
 *
 * Escape leaves, and so does a route change: you should never land on a new
 * page with the navigation missing.
 */
export function FocusModeProvider({ children }: { children: ReactNode }) {
  const [focus, setFocus] = useState(false);
  const { pathname } = useLocation();

  const enter = useCallback(() => setFocus(true), []);
  const exit = useCallback(() => setFocus(false), []);

  useEffect(() => {
    setFocus(false);
  }, [pathname]);

  useEffect(() => {
    if (!focus) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape belongs to whatever field has the caret (the canvas search box
      // clears itself with it); only an unfocused Escape leaves fullscreen.
      const target = event.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable
      ) {
        return;
      }
      setFocus(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focus]);

  const value = useMemo<FocusMode>(
    () => ({ focus, available: true, enter, exit }),
    [focus, enter, exit],
  );

  return (
    <FocusModeContext.Provider value={value}>{children}</FocusModeContext.Provider>
  );
}

export function useFocusMode(): FocusMode {
  return useContext(FocusModeContext);
}

/**
 * Enter/leave fullscreen. Lives in the view strip — the one piece of chrome that
 * survives focus mode — so the way out is always on screen.
 */
export function FocusToggle({ className }: { className?: string }) {
  const { focus, available, enter, exit } = useFocusMode();
  if (!available) return null;

  if (focus) {
    return (
      <button
        type="button"
        onClick={exit}
        className={cn(
          "text-muted-foreground hover:text-ink inline-flex items-center gap-1.5 font-mono text-xs transition-colors",
          className,
        )}
      >
        <Minimize2 className="size-3.5" />
        Exit fullscreen
        <kbd className="border-border text-faint rounded border px-1 font-mono text-[10px]">
          Esc
        </kbd>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={enter}
      title="Fullscreen"
      className={cn(
        "text-muted-foreground hover:text-ink hover:bg-accent/60 rounded-sm p-1 transition-colors",
        className,
      )}
    >
      <Maximize2 className="size-4" />
      <span className="sr-only">Fullscreen</span>
    </button>
  );
}
