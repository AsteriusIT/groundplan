/**
 * How the node details panel sizes itself: fixed (default) or resizable by
 * dragging its left edge. A preference, not a decision — it lives where the
 * theme lives (Settings → Appearance), persisted per device.
 *
 * Unlike theme/tour, `usePanelPrefs` returns the defaults when no provider is
 * mounted: the defaults are the off-state, and the panel renders in dozens of
 * page tests that shouldn't each have to mount a provider for a preference
 * they don't exercise. The app always mounts it (main.tsx).
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type PanelMode = "fixed" | "resizable";

export const PANEL_MODE_STORAGE_KEY = "groundplan-panel-mode";
export const PANEL_WIDTH_STORAGE_KEY = "groundplan-panel-width";

export const PANEL_MIN_WIDTH = 320;
export const PANEL_MAX_WIDTH = 720;
export const PANEL_DEFAULT_WIDTH = 416;

function clampWidth(width: number): number {
  return Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, width));
}

type PanelPrefsValue = {
  mode: PanelMode;
  setMode: (mode: PanelMode) => void;
  width: number;
  setWidth: (width: number) => void;
};

const DEFAULTS: PanelPrefsValue = {
  mode: "fixed",
  setMode: () => {},
  width: PANEL_DEFAULT_WIDTH,
  setWidth: () => {},
};

const PanelPrefsContext = createContext<PanelPrefsValue | null>(null);

function readMode(): PanelMode {
  return localStorage.getItem(PANEL_MODE_STORAGE_KEY) === "resizable"
    ? "resizable"
    : "fixed";
}

function readWidth(): number {
  const stored = Number(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY));
  if (!Number.isFinite(stored) || stored === 0) return PANEL_DEFAULT_WIDTH;
  return clampWidth(stored);
}

export function PanelPrefsProvider({
  children,
}: Readonly<{ children: ReactNode }>) {
  const [mode, setModeState] = useState<PanelMode>(readMode);
  const [width, setWidthState] = useState<number>(readWidth);

  const setMode = useCallback((next: PanelMode) => {
    localStorage.setItem(PANEL_MODE_STORAGE_KEY, next);
    setModeState(next);
  }, []);

  const setWidth = useCallback((next: number) => {
    const clamped = clampWidth(next);
    localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(clamped));
    setWidthState(clamped);
  }, []);

  const value = useMemo(
    () => ({ mode, setMode, width, setWidth }),
    [mode, setMode, width, setWidth],
  );

  return <PanelPrefsContext value={value}>{children}</PanelPrefsContext>;
}

export function usePanelPrefs(): PanelPrefsValue {
  return useContext(PanelPrefsContext) ?? DEFAULTS;
}
