import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ThemeProvider, useTheme } from "./theme-provider";

function Consumer() {
  const { theme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <button type="button" onClick={() => setTheme("light")}>
        light
      </button>
      <button type="button" onClick={() => setTheme("blueprint")}>
        blueprint
      </button>
      <button type="button" onClick={() => setTheme("carbon")}>
        carbon
      </button>
    </div>
  );
}

const renderProvider = () =>
  render(
    <ThemeProvider>
      <Consumer />
    </ThemeProvider>,
  );

const root = () => document.documentElement;

describe("ThemeProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    root().classList.remove("dark");
    root().removeAttribute("data-theme");
    vi.unstubAllGlobals();
  });

  it("defaults to the carbon dark theme when nothing is stored", () => {
    renderProvider();
    expect(screen.getByTestId("theme")).toHaveTextContent("carbon");
    expect(root()).toHaveClass("dark");
    expect(root().getAttribute("data-theme")).toBe("carbon");
  });

  it("restores a stored blueprint theme (.dark, no data-theme)", () => {
    localStorage.setItem("groundplan-theme", "blueprint");
    renderProvider();
    expect(screen.getByTestId("theme")).toHaveTextContent("blueprint");
    expect(root()).toHaveClass("dark");
    expect(root().getAttribute("data-theme")).toBeNull();
  });

  it("restores a stored carbon theme (.dark + data-theme=carbon)", () => {
    localStorage.setItem("groundplan-theme", "carbon");
    renderProvider();
    expect(screen.getByTestId("theme")).toHaveTextContent("carbon");
    expect(root()).toHaveClass("dark");
    expect(root().getAttribute("data-theme")).toBe("carbon");
  });

  it("switches between all three themes, reflecting <html> and persisting", () => {
    renderProvider();
    // By role: the readout <span> also holds the name of the current theme.
    const pick = (theme: string) =>
      fireEvent.click(screen.getByRole("button", { name: theme }));

    pick("carbon");
    expect(root()).toHaveClass("dark");
    expect(root().getAttribute("data-theme")).toBe("carbon");
    expect(localStorage.getItem("groundplan-theme")).toBe("carbon");

    pick("blueprint");
    expect(root()).toHaveClass("dark");
    expect(root().getAttribute("data-theme")).toBeNull();
    expect(localStorage.getItem("groundplan-theme")).toBe("blueprint");

    pick("light");
    expect(root()).not.toHaveClass("dark");
    expect(root().getAttribute("data-theme")).toBeNull();
    expect(localStorage.getItem("groundplan-theme")).toBe("light");
  });

  it("defaults to carbon regardless of the OS light preference", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    renderProvider();
    expect(screen.getByTestId("theme")).toHaveTextContent("carbon");
  });

  it("throws when useTheme is used outside a ThemeProvider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Consumer />)).toThrow(/ThemeProvider/);
    spy.mockRestore();
  });
});
