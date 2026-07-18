import { beforeEach, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import {
  PANEL_MODE_STORAGE_KEY,
  PANEL_WIDTH_STORAGE_KEY,
  PanelPrefsProvider,
  usePanelPrefs,
} from "./panel-prefs";

function wrapper({ children }: Readonly<{ children: ReactNode }>) {
  return <PanelPrefsProvider>{children}</PanelPrefsProvider>;
}

beforeEach(() => {
  localStorage.clear();
});

it("defaults to a fixed panel at 416px", () => {
  const { result } = renderHook(() => usePanelPrefs(), { wrapper });
  expect(result.current.mode).toBe("fixed");
  expect(result.current.width).toBe(416);
});

it("persists the mode and the width", () => {
  const { result } = renderHook(() => usePanelPrefs(), { wrapper });
  act(() => result.current.setMode("resizable"));
  act(() => result.current.setWidth(500));
  expect(localStorage.getItem(PANEL_MODE_STORAGE_KEY)).toBe("resizable");
  expect(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY)).toBe("500");
  expect(result.current.mode).toBe("resizable");
  expect(result.current.width).toBe(500);
});

it("restores stored preferences", () => {
  localStorage.setItem(PANEL_MODE_STORAGE_KEY, "resizable");
  localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, "512");
  const { result } = renderHook(() => usePanelPrefs(), { wrapper });
  expect(result.current.mode).toBe("resizable");
  expect(result.current.width).toBe(512);
});

it("clamps the width to [320, 720] on write and on read", () => {
  const { result } = renderHook(() => usePanelPrefs(), { wrapper });
  act(() => result.current.setWidth(100));
  expect(result.current.width).toBe(320);
  act(() => result.current.setWidth(9000));
  expect(result.current.width).toBe(720);

  localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, "50");
  const { result: reread } = renderHook(() => usePanelPrefs(), { wrapper });
  expect(reread.current.width).toBe(320);
});

it("falls back to 416 for a garbage stored width", () => {
  localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, "not-a-number");
  const { result } = renderHook(() => usePanelPrefs(), { wrapper });
  expect(result.current.width).toBe(416);
});

it("returns the defaults without a provider — the off-state, never a throw", () => {
  const { result } = renderHook(() => usePanelPrefs());
  expect(result.current.mode).toBe("fixed");
  expect(result.current.width).toBe(416);
});
