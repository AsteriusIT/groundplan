import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it } from "vitest";

import { ViewSwitcher, viewsFor } from "./view-switcher";

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

it("labels the infra tab 'Global' on the docs page, without changing the ?view value", () => {
  render(
    <MemoryRouter initialEntries={["/x?view=network"]}>
      <ViewSwitcher variant="docs" />
    </MemoryRouter>,
  );
  expect(screen.queryByRole("button", { name: /plan impact/i })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: /^global$/i }));

  expect(screen.getByRole("button", { name: /^global$/i })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

it("reflects and selects the ?view=iam param (GP-48)", () => {
  render(
    <MemoryRouter initialEntries={["/x?view=iam"]}>
      <ViewSwitcher />
    </MemoryRouter>,
  );
  expect(screen.getByRole("button", { name: /iam/i })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  fireEvent.click(screen.getByRole("button", { name: /network/i }));
  expect(screen.getByRole("button", { name: /network/i })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("button", { name: /iam/i })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

it("playground offers Global/Network/IAM for Terraform, diagram only for Kubernetes", () => {
  expect(viewsFor("playground", false)).toEqual(["infra", "network", "iam"]);
  expect(viewsFor("playground", true)).toEqual(["infra"]);
});

// --- Reality vs Code (GP-209) ------------------------------------------------

it("offers the reality lens on docs only when a reality snapshot exists", () => {
  expect(viewsFor("docs", false)).not.toContain("reality");
  expect(viewsFor("docs", false, { reality: true })).toContain("reality");
});

it("puts reality last — it is the lens you reach for, not the one you land on", () => {
  expect(viewsFor("docs", false, { reality: true })).toEqual([
    "infra",
    "adapted",
    "c4",
    "network",
    "iam",
    "reality",
  ]);
});

it("never offers reality on a Kubernetes repository — a cluster is its own view", () => {
  expect(viewsFor("docs", true, { reality: true })).toEqual(["infra"]);
});

it("never offers reality on a pull request or in the playground", () => {
  expect(viewsFor("plan", false, { reality: true })).not.toContain("reality");
  expect(viewsFor("playground", false, { reality: true })).not.toContain("reality");
});
