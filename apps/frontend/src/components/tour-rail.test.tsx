/**
 * GP-79: the guide chrome. The whole walk, visible, and any stop one click away.
 */
import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";

import type { Tour } from "@/api/types";

import { TourRail } from "./tour-rail";

const TOUR: Tour = {
  title: "Adds an ingestion queue",
  view: "infra",
  steps: [
    { anchors: [], title: "What this does", body: "Two resources move." },
    { anchors: ["a"], title: "The new queue", body: "Everything hangs off `a`." },
    { anchors: ["b"], title: "The old store goes", body: "Check the backups." },
  ],
};

function renderRail(index = 1, handlers: Partial<Record<string, () => void>> = {}) {
  const props = {
    onGoTo: vi.fn(),
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onExit: vi.fn(),
    ...handlers,
  };
  render(
    <TourRail
      tour={TOUR}
      index={index}
      model="claude-opus-4-8"
      onGoTo={props.onGoTo as (i: number) => void}
      onNext={props.onNext as () => void}
      onPrev={props.onPrev as () => void}
      onExit={props.onExit as () => void}
    />,
  );
  return props;
}

it("shows every stop, so you can see how long this is going to take", () => {
  renderRail();

  expect(screen.getByText("What this does")).toBeInTheDocument();
  expect(screen.getByText("The new queue")).toBeInTheDocument();
  expect(screen.getByText("The old store goes")).toBeInTheDocument();
  expect(screen.getByText("Tour · 3 stops")).toBeInTheDocument();
});

it("expands only the current stop, and marks it for a screen reader", () => {
  renderRail(1);

  // Only the current stop's prose is on screen — the rail is a table of contents
  // with one chapter open, not the whole tour dumped at once.
  expect(screen.getByText(/Everything hangs off/)).toBeInTheDocument();
  expect(screen.queryByText(/Check the backups/)).not.toBeInTheDocument();

  const current = screen.getByRole("button", { current: "step" });
  expect(current).toHaveTextContent("The new queue");
});

it("says a model wrote it, and which one", () => {
  renderRail();
  expect(screen.getByText("AI")).toBeInTheDocument();
  expect(screen.getByText("claude-opus-4-8")).toBeInTheDocument();
});

it("jumps to any stop — the reason to want this chrome at all", () => {
  const { onGoTo } = renderRail(1);

  fireEvent.click(screen.getByRole("button", { name: /The old store goes/ }));
  expect(onGoTo).toHaveBeenCalledWith(2);
});

it("cannot go back from the first stop", () => {
  renderRail(0);
  expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
});

it("offers Done, not Next, on the last stop", () => {
  renderRail(2);
  expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
});

it("can be left", () => {
  const { onExit } = renderRail();
  fireEvent.click(screen.getByRole("button", { name: "End tour" }));
  expect(onExit).toHaveBeenCalled();
});

it("has no accessibility violations", async () => {
  const { baseElement } = render(
    <TourRail
      tour={TOUR}
      index={0}
      model="claude-opus-4-8"
      onGoTo={vi.fn()}
      onNext={vi.fn()}
      onPrev={vi.fn()}
      onExit={vi.fn()}
    />,
  );
  const results = await axe(baseElement);
  expect(results.violations).toEqual([]);
});
