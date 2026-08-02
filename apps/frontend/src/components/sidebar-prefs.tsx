/**
 * Whether the sidebar is expanded or folded to a logo-only rail (GP-243).
 *
 * A preference, not state: it belongs to the person, survives navigation and
 * reload, and is stored per device — the panel-prefs pattern, including the
 * rule that `useSidebarPrefs` returns the defaults when no provider is mounted,
 * so the dozens of page tests that render a shell fragment do not each have to
 * wrap one for a preference they never touch. The app always mounts it
 * (main.tsx).
 *
 * The shortcut lives here rather than in the sidebar because it is the whole
 * window's: the point of folding the rail is to give the canvas its width, and
 * the hands doing that are on the canvas, not on the sidebar.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export const SIDEBAR_COLLAPSED_STORAGE_KEY = "groundplan-sidebar-collapsed";

type SidebarPrefsValue = {
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  toggle: () => void;
};

const DEFAULTS: SidebarPrefsValue = {
  collapsed: false,
  setCollapsed: () => {},
  toggle: () => {},
};

const SidebarPrefsContext = createContext<SidebarPrefsValue | null>(null);

function readCollapsed(): boolean {
  return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
}

/** A keystroke aimed at text is text, never a window command. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
  );
}

export function SidebarPrefsProvider({
  children,
}: Readonly<{ children: ReactNode }>) {
  const [collapsed, setCollapsedState] = useState<boolean>(readCollapsed);

  const setCollapsed = useCallback((next: boolean) => {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next));
    setCollapsedState(next);
  }, []);

  const toggle = useCallback(() => {
    setCollapsedState((current) => {
      const next = !current;
      localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  // Cmd/Ctrl+B, the shortcut every editor already taught everybody.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "b") {
        return;
      }
      if (isTyping(event.target)) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  const value = useMemo(
    () => ({ collapsed, setCollapsed, toggle }),
    [collapsed, setCollapsed, toggle],
  );

  return <SidebarPrefsContext value={value}>{children}</SidebarPrefsContext>;
}

export function useSidebarPrefs(): SidebarPrefsValue {
  return useContext(SidebarPrefsContext) ?? DEFAULTS;
}
