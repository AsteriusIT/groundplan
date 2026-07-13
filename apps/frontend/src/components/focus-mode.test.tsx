import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it } from "vitest";

import { FocusModeProvider, FocusToggle, useFocusMode } from "./focus-mode";

function Harness() {
  const { focus } = useFocusMode();
  return (
    <div>
      <span data-testid="state">{focus ? "focused" : "normal"}</span>
      <input aria-label="Search resources" />
      <FocusToggle />
    </div>
  );
}

function renderHarness() {
  return render(
    <MemoryRouter>
      <FocusModeProvider>
        <Harness />
      </FocusModeProvider>
    </MemoryRouter>,
  );
}

const state = () => screen.getByTestId("state").textContent;

it("enters and leaves fullscreen from the toggle", () => {
  renderHarness();
  expect(state()).toBe("normal");

  fireEvent.click(screen.getByRole("button", { name: /^fullscreen$/i }));
  expect(state()).toBe("focused");

  fireEvent.click(screen.getByRole("button", { name: /exit fullscreen/i }));
  expect(state()).toBe("normal");
});

it("leaves fullscreen on Escape", () => {
  renderHarness();
  fireEvent.click(screen.getByRole("button", { name: /^fullscreen$/i }));

  fireEvent.keyDown(window, { key: "Escape" });

  expect(state()).toBe("normal");
});

it("ignores Escape typed into a field, so the canvas search can clear itself", () => {
  renderHarness();
  fireEvent.click(screen.getByRole("button", { name: /^fullscreen$/i }));

  fireEvent.keyDown(screen.getByRole("textbox", { name: /search resources/i }), {
    key: "Escape",
  });

  expect(state()).toBe("focused");
});

it("offers no toggle outside the provider — the public share canvas has no chrome to hide", () => {
  render(
    <MemoryRouter>
      <FocusToggle />
    </MemoryRouter>,
  );
  expect(screen.queryByRole("button")).toBeNull();
});
