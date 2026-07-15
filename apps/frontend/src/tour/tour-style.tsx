/**
 * GP-79: how a guided tour is presented. One engine, two chromes:
 *
 *   • "spotlight" — the diagram dims, the stop stays lit, and a card is pinned to
 *     the nodes it is about. The product-tour feel: you are being shown a thing.
 *   • "guide"     — the whole tour lists in a rail beside the canvas, current stop
 *     expanded, any stop one click away. The reviewable feel: you are reading a
 *     document that happens to move the camera.
 *
 * Neither is right for everyone, which is why this is a preference and not a
 * decision we made for you. It lives where the theme lives — a global setting,
 * persisted, changed in Settings → Appearance and nowhere else.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type TourStyle = "spotlight" | "guide";

export const TOUR_STYLES: readonly TourStyle[] = ["spotlight", "guide"];

export const TOUR_STYLE_STORAGE_KEY = "groundplan-tour-style";

function isTourStyle(value: string | null): value is TourStyle {
  return value === "spotlight" || value === "guide";
}

type TourStyleContextValue = {
  style: TourStyle;
  setStyle: (style: TourStyle) => void;
};

const TourStyleContext = createContext<TourStyleContextValue | null>(null);

/** The stored preference, else the spotlight — a tour should feel like a tour. */
export function resolveInitialTourStyle(): TourStyle {
  const stored = localStorage.getItem(TOUR_STYLE_STORAGE_KEY);
  if (isTourStyle(stored)) return stored;
  return "spotlight";
}

export function TourStyleProvider({
  children,
}: Readonly<{ children: ReactNode }>) {
  const [styleState, setStyleState] = useState<TourStyle>(
    resolveInitialTourStyle,
  );

  const setStyle = useCallback((next: TourStyle) => {
    localStorage.setItem(TOUR_STYLE_STORAGE_KEY, next);
    setStyleState(next);
  }, []);

  const value = useMemo(
    () => ({ style: styleState, setStyle }),
    [styleState, setStyle],
  );

  return <TourStyleContext value={value}>{children}</TourStyleContext>;
}

export function useTourStyle(): TourStyleContextValue {
  const ctx = useContext(TourStyleContext);
  if (!ctx) {
    throw new Error("useTourStyle must be used within a TourStyleProvider");
  }
  return ctx;
}
