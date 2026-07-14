/**
 * GP-79: the way into a tour — and the rule every AI surface obeys.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { getAiStatus } from "@/api/client";
import { resetAiStatus } from "@/lib/use-ai-status";
import type { TourPlayer } from "@/tour/use-tour";

import { TourLauncher } from "./tour-launcher";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, getAiStatus: vi.fn() };
});

const getAiStatusMock = vi.mocked(getAiStatus);

function player(over: Partial<TourPlayer> = {}): TourPlayer {
  return {
    status: "idle",
    tour: null,
    model: null,
    error: null,
    step: null,
    index: 0,
    total: 0,
    start: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    goTo: vi.fn(),
    exit: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  resetAiStatus();
  getAiStatusMock.mockResolvedValue({ enabled: true, model: "claude-opus-4-8" });
});

it("offers the tour when the AI layer is on", async () => {
  render(<TourLauncher player={player()} />);
  expect(
    await screen.findByRole("button", { name: /take the tour/i }),
  ).toBeInTheDocument();
});

it("does not exist when the AI layer is off", async () => {
  // No key, no model, no button. The feature is absent, not present-and-broken.
  getAiStatusMock.mockResolvedValue({ enabled: false, model: null });
  render(<TourLauncher player={player()} />);

  await waitFor(() => expect(getAiStatusMock).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: /take the tour/i })).toBeNull();
});

it("generates only when asked — never on mount", async () => {
  const p = player();
  render(<TourLauncher player={p} />);

  const button = await screen.findByRole("button", { name: /take the tour/i });
  expect(p.start).not.toHaveBeenCalled();

  fireEvent.click(button);
  expect(p.start).toHaveBeenCalledTimes(1);
});

it("gets out of the way once a tour is running", async () => {
  render(
    <TourLauncher
      player={player({
        status: "playing",
        step: { anchors: [], title: "T", body: "B" },
        total: 1,
      })}
    />,
  );

  await waitFor(() => expect(getAiStatusMock).toHaveBeenCalled());
  // The chrome is the control now. A second button here just restarts the tour
  // by accident.
  expect(screen.queryByRole("button", { name: /take the tour/i })).toBeNull();
});

it("says so when the tour could not be built", async () => {
  render(
    <TourLauncher
      player={player({ status: "error", error: "the AI provider failed" })}
    />,
  );

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "the AI provider failed",
  );
});
