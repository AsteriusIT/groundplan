/**
 * Theme provider — one light theme and two dark themes:
 *   • "light"     — "drafting paper" (default `:root` tokens)
 *   • "blueprint" — cyanotype blueprint (deep Prussian blue) → `.dark`
 *   • "carbon"    — near-neutral graphite black → `.dark` + data-theme="carbon"
 *
 * The whole palette lives in `index.css`; this provider just reflects the chosen
 * theme onto <html> (the `.dark` class + a `data-theme` attribute) and persists
 * it. Both dark themes carry `.dark` so Tailwind's `dark:` variant and all
 * status/diff colours apply; `data-theme="carbon"` re-points the neutral family.
 *
 * Initial theme = the user's stored choice, else the OS preference (dark → the
 * signature blueprint). A tiny inline script in `index.html` applies the same
 * resolution before first paint (no flash).
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

export type Theme = "light" | "blueprint" | "carbon";

export const THEMES: readonly Theme[] = ["light", "blueprint", "carbon"];

export const THEME_STORAGE_KEY = "groundplan-theme";

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "blueprint" || value === "carbon";
}

type ThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** The stored preference if the user has chosen one, else the OS preference. */
export function resolveInitialTheme(): Theme {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (isTheme(stored)) return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "blueprint"
    : "light";
}

/** Reflect a theme onto <html>: `.dark` for either dark theme, `data-theme` for carbon. */
function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", theme !== "light");
  if (theme === "carbon") root.dataset.theme = "carbon";
  else delete root.dataset.theme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(resolveInitialTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem(THEME_STORAGE_KEY, next);
    setThemeState(next);
  }, []);

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);

  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return ctx;
}
