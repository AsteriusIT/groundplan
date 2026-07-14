/**
 * GP-79: the tour-style preference. Persisted, and it decides which chrome runs.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { TourStyleSwitcher } from "@/components/tour-style-switcher";

import {
  TourStyleProvider,
  TOUR_STYLE_STORAGE_KEY,
  resolveInitialTourStyle,
  useTourStyle,
} from "./tour-style";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

it("defaults to the spotlight — a tour should feel like a tour", () => {
  expect(resolveInitialTourStyle()).toBe("spotlight");
});

it("honours a stored preference, and ignores a corrupt one", () => {
  localStorage.setItem(TOUR_STYLE_STORAGE_KEY, "guide");
  expect(resolveInitialTourStyle()).toBe("guide");

  localStorage.setItem(TOUR_STYLE_STORAGE_KEY, "interpretive-dance");
  expect(resolveInitialTourStyle()).toBe("spotlight");
});

/** A component that just says which chrome it is being told to render. */
function Chrome() {
  const { style } = useTourStyle();
  return <p>chrome: {style}</p>;
}

it("switching the setting switches which chrome renders, and is remembered", () => {
  render(
    <TourStyleProvider>
      <TourStyleSwitcher />
      <Chrome />
    </TourStyleProvider>,
  );

  expect(screen.getByText("chrome: spotlight")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Guide" }));

  expect(screen.getByText("chrome: guide")).toBeInTheDocument();
  // Remembered on this device, like the theme it sits beside in Settings.
  expect(localStorage.getItem(TOUR_STYLE_STORAGE_KEY)).toBe("guide");
});

it("says which style is active, for a screen reader too", () => {
  render(
    <TourStyleProvider>
      <TourStyleSwitcher />
    </TourStyleProvider>,
  );

  expect(screen.getByRole("button", { name: "Spotlight" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("button", { name: "Guide" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});
