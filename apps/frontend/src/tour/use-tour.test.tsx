/**
 * GP-79: the tour engine. What it means to be on a stop, and to leave.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { getTour, generateTour, ApiError } from "@/api/client";
import type { GraphView } from "@/components/view-switcher";

import { useTourPlayer } from "./use-tour";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, getTour: vi.fn(), generateTour: vi.fn() };
});

const getTourMock = vi.mocked(getTour);
const generateTourMock = vi.mocked(generateTour);

const TOUR = {
  title: "A change",
  view: "infra" as const,
  steps: [
    { anchors: [], title: "Overview", body: "What this does." },
    { anchors: ["a"], title: "The queue", body: "The new queue." },
    { anchors: ["b", "c"], title: "The fallout", body: "These two are impacted." },
  ],
};

/** A stand-in for `useGraphView`, so we can watch what the tour does to the view. */
function viewSpy(initial: GraphView = "network") {
  const spy = {
    view: initial,
    setView: vi.fn((next: GraphView) => {
      spy.view = next;
    }),
  };
  return spy;
}

beforeEach(() => {
  getTourMock.mockResolvedValue({ tour: TOUR, model: "test-model", cached: true });
  generateTourMock.mockResolvedValue({
    tour: TOUR,
    model: "test-model",
    cached: false,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

it("does not generate a tour just because a page was opened", () => {
  const view = viewSpy();
  renderHook(() => useTourPlayer("snap-1", view));

  // A tour costs money. Nobody asked for one by navigating here.
  expect(getTourMock).not.toHaveBeenCalled();
  expect(generateTourMock).not.toHaveBeenCalled();
});

it("replays a cached tour rather than paying for a new one", async () => {
  const view = viewSpy();
  const { result } = renderHook(() => useTourPlayer("snap-1", view));

  act(() => result.current.start());
  await waitFor(() => expect(result.current.status).toBe("playing"));

  expect(getTourMock).toHaveBeenCalledWith("snap-1");
  expect(generateTourMock).not.toHaveBeenCalled();
  expect(result.current.step?.title).toBe("Overview");
  expect(result.current.total).toBe(3);
});

it("generates when there is nothing cached, and when told to regenerate", async () => {
  getTourMock.mockResolvedValue(null);
  const view = viewSpy();
  const { result } = renderHook(() => useTourPlayer("snap-1", view));

  act(() => result.current.start());
  await waitFor(() => expect(result.current.status).toBe("playing"));
  expect(generateTourMock).toHaveBeenCalledTimes(1);

  act(() => result.current.exit());
  act(() => result.current.start({ regenerate: true }));
  await waitFor(() => expect(result.current.status).toBe("playing"));

  // Regenerating must not consult the cache first — that is the whole request.
  expect(getTourMock).toHaveBeenCalledTimes(1);
  expect(generateTourMock).toHaveBeenLastCalledWith("snap-1", { regenerate: true });
});

it("switches to the tour's lens, and gives back the one you were on", async () => {
  const view = viewSpy("network");
  const { result } = renderHook(() => useTourPlayer("snap-1", view));

  act(() => result.current.start());
  await waitFor(() => expect(result.current.status).toBe("playing"));
  expect(view.setView).toHaveBeenCalledWith("infra");

  act(() => result.current.exit());

  // A tour that quietly leaves you on a different diagram than you arrived on is
  // a tour that stole your place.
  expect(view.setView).toHaveBeenLastCalledWith("network");
  expect(result.current.status).toBe("idle");
  expect(result.current.step).toBeNull();
});

it("walks forward and back, and ends rather than sticking on the last stop", async () => {
  const view = viewSpy();
  const { result } = renderHook(() => useTourPlayer("snap-1", view));

  act(() => result.current.start());
  await waitFor(() => expect(result.current.status).toBe("playing"));

  act(() => result.current.next());
  expect(result.current.index).toBe(1);
  act(() => result.current.next());
  expect(result.current.index).toBe(2);

  // Past the closer, "next" ends the tour. A Next button that does nothing is a
  // button that says the tour is broken.
  act(() => result.current.next());
  expect(result.current.status).toBe("idle");
});

it("back stops at the first stop instead of falling off the front", async () => {
  const view = viewSpy();
  const { result } = renderHook(() => useTourPlayer("snap-1", view));
  act(() => result.current.start());
  await waitFor(() => expect(result.current.status).toBe("playing"));

  act(() => result.current.prev());
  expect(result.current.index).toBe(0);
  expect(result.current.status).toBe("playing");
});

it("goTo refuses to land outside the tour", async () => {
  const view = viewSpy();
  const { result } = renderHook(() => useTourPlayer("snap-1", view));
  act(() => result.current.start());
  await waitFor(() => expect(result.current.status).toBe("playing"));

  act(() => result.current.goTo(2));
  expect(result.current.index).toBe(2);

  act(() => result.current.goTo(9));
  expect(result.current.index).toBe(2);
  act(() => result.current.goTo(-1));
  expect(result.current.index).toBe(2);
});

it("drives from the keyboard — a tour you must mouse through is a slideshow", async () => {
  const view = viewSpy();
  const { result } = renderHook(() => useTourPlayer("snap-1", view));
  act(() => result.current.start());
  await waitFor(() => expect(result.current.status).toBe("playing"));

  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
  });
  expect(result.current.index).toBe(1);

  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
  });
  expect(result.current.index).toBe(0);

  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  expect(result.current.status).toBe("idle");
});

it("keeps its hands off the keyboard while you are typing", async () => {
  const view = viewSpy();
  const { result } = renderHook(() => useTourPlayer("snap-1", view));
  act(() => result.current.start());
  await waitFor(() => expect(result.current.status).toBe("playing"));

  // The canvas has a search box. Space in it is a space, not "next stop".
  const input = document.createElement("input");
  document.body.appendChild(input);
  act(() => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true }),
    );
  });
  expect(result.current.index).toBe(0);
  input.remove();
});

it("surfaces a failed generation instead of pretending there is a tour", async () => {
  getTourMock.mockResolvedValue(null);
  generateTourMock.mockRejectedValue(
    new ApiError(502, "the model did not return a usable tour: no JSON object"),
  );
  const view = viewSpy();
  const { result } = renderHook(() => useTourPlayer("snap-1", view));

  act(() => result.current.start());
  await waitFor(() => expect(result.current.status).toBe("error"));

  expect(result.current.error).toMatch(/usable tour/);
  expect(result.current.step).toBeNull();
  // ...and the failure left the view alone.
  expect(view.setView).not.toHaveBeenCalled();
});

it("drops the tour when the snapshot changes underneath it", async () => {
  const view = viewSpy();
  const { result, rerender } = renderHook(
    ({ id }: { id: string }) => useTourPlayer(id, view),
    { initialProps: { id: "snap-1" } },
  );

  act(() => result.current.start());
  await waitFor(() => expect(result.current.status).toBe("playing"));

  // A different snapshot is a different diagram; the narration is not about what
  // is now on screen.
  rerender({ id: "snap-2" });
  expect(result.current.status).toBe("idle");
  expect(result.current.step).toBeNull();
});
