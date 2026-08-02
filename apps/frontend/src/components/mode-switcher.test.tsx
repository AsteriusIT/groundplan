import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, getAiStatus: vi.fn() };
});

import { getAiStatus } from "@/api/client";
import { modeForPath } from "@/lib/app-mode";
import { resetAiStatus } from "@/lib/use-ai-status";
import { ModeSwitcher } from "./mode-switcher";

const aiStatusMock = vi.mocked(getAiStatus);

let lastPath = "";
function LocationProbe() {
  lastPath = useLocation().pathname;
  return null;
}

function renderSwitcher(path = "/dashboard") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <ModeSwitcher />
      <LocationProbe />
    </MemoryRouter>,
  );
}

/** Radix opens a menu on keyboard activation; jsdom has no real pointer. */
function openMenu() {
  fireEvent.keyDown(screen.getByRole("button", { name: /^Mode:/ }), {
    key: "Enter",
  });
}

beforeEach(() => {
  resetAiStatus();
  aiStatusMock.mockResolvedValue({ enabled: true, model: "claude-opus-4-8" });
});

it("derives the mode from the URL, deep links included", () => {
  expect(modeForPath("/dashboard")).toBe("docs");
  expect(modeForPath("/projects/p1/repos/r1/pulls/7")).toBe("docs");
  expect(modeForPath("/policies")).toBe("docs");
  expect(modeForPath("/playground/editor")).toBe("playground");
  expect(modeForPath("/clusters/c1")).toBe("clusters");
  expect(modeForPath("/studio")).toBe("studio");
  // Anything unclaimed is Documentation rather than nowhere.
  expect(modeForPath("/settings")).toBe("docs");
});

it("names the active mode and lists exactly the four available ones", async () => {
  renderSwitcher("/clusters");
  expect(
    await screen.findByRole("button", { name: "Mode: Kubernetes Clusters" }),
  ).toBeInTheDocument();

  openMenu();
  const items = await screen.findAllByRole("menuitem");
  expect(items.map((item) => item.textContent?.split("Review")[0])).toHaveLength(
    4,
  );
  for (const label of [
    "Terraform Documentation",
    "Playground",
    "AI Studio",
    "Kubernetes Clusters",
  ]) {
    expect(screen.getByRole("menuitem", { name: new RegExp(label) })).toBeTruthy();
  }
});

it("marks the mode the current URL belongs to", async () => {
  renderSwitcher("/playground/build");
  openMenu();
  expect(
    await screen.findByRole("menuitem", { name: /Playground/ }),
  ).toHaveAttribute("aria-current", "true");
  expect(
    screen.getByRole("menuitem", { name: /Terraform Documentation/ }),
  ).not.toHaveAttribute("aria-current");
});

it("navigates to the selected mode's root", async () => {
  renderSwitcher("/dashboard");
  openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /Playground/ }));
  expect(lastPath).toBe("/playground");
});

it("does not offer AI Studio when the AI layer is off (GP-62's rule)", async () => {
  aiStatusMock.mockResolvedValue({ enabled: false, model: null });
  renderSwitcher("/dashboard");
  openMenu();
  expect(
    await screen.findByRole("menuitem", { name: /Terraform Documentation/ }),
  ).toBeInTheDocument();
  expect(screen.queryByText("AI Studio")).not.toBeInTheDocument();
});

it("reads a stale AI Studio link as Documentation when AI is off", async () => {
  aiStatusMock.mockResolvedValue({ enabled: false, model: null });
  renderSwitcher("/studio");
  expect(
    await screen.findByRole("button", { name: "Mode: Terraform Documentation" }),
  ).toBeInTheDocument();
});
