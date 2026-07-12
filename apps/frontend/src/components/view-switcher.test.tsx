import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it } from "vitest";

import { ViewSwitcher } from "./view-switcher";

it("reflects the ?view=network param and toggles between views", () => {
  render(
    <MemoryRouter initialEntries={["/x?view=network"]}>
      <ViewSwitcher />
    </MemoryRouter>,
  );
  expect(screen.getByRole("button", { name: /network/i })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  fireEvent.click(screen.getByRole("button", { name: /plan impact/i }));

  expect(screen.getByRole("button", { name: /plan impact/i })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("button", { name: /network/i })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

it("defaults to the plan-impact view when no param is set", () => {
  render(
    <MemoryRouter initialEntries={["/x"]}>
      <ViewSwitcher />
    </MemoryRouter>,
  );
  expect(screen.getByRole("button", { name: /plan impact/i })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
