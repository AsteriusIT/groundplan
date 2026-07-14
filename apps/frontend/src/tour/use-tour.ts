/**
 * GP-79: the tour engine.
 *
 * One state machine, shared by both chromes. It owns *which stop we are on* and
 * nothing about how a stop looks — that is the whole point of the split. The
 * spotlight card and the guide rail are two renderings of this hook's output, and
 * either can be swapped out without touching the thing that runs the tour.
 *
 * The view is part of the machine, not a side effect of it: a tour is written
 * against a lens, so starting one switches to that lens and ending one puts you
 * back where you were. A tour that quietly leaves you on a different diagram than
 * you arrived on is a tour that stole your place.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, generateTour, getTour } from "@/api/client";
import type { Tour, TourStep } from "@/api/types";
import type { GraphView } from "@/components/view-switcher";

export type TourStatus = "idle" | "loading" | "playing" | "error";

export type TourPlayer = {
  status: TourStatus;
  tour: Tour | null;
  /** The model that wrote it. Shown to the reader — they should know. */
  model: string | null;
  error: string | null;
  /** The current stop, or null when no tour is playing. */
  step: TourStep | null;
  index: number;
  total: number;
  /** Fetch the cached tour (or generate one) and start playing. */
  start: (opts?: { regenerate?: boolean }) => void;
  next: () => void;
  prev: () => void;
  goTo: (index: number) => void;
  exit: () => void;
};

export function useTourPlayer(
  snapshotId: string,
  view: { view: GraphView; setView: (v: GraphView) => void },
): TourPlayer {
  const [status, setStatus] = useState<TourStatus>("idle");
  const [tour, setTour] = useState<Tour | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);

  // The view the user was on when the tour started, so exiting can give it back.
  const returnView = useRef<GraphView | null>(null);
  // `setView` comes from useSearchParams and is a new function every render;
  // depending on it would restart the tour on every keystroke elsewhere.
  const viewRef = useRef(view);
  viewRef.current = view;

  const exit = useCallback(() => {
    setStatus("idle");
    setTour(null);
    setIndex(0);
    setError(null);
    const previous = returnView.current;
    returnView.current = null;
    if (previous) viewRef.current.setView(previous);
  }, []);

  // A different snapshot is a different diagram; whatever we were narrating is
  // not what is on screen any more.
  useEffect(() => {
    setStatus("idle");
    setTour(null);
    setIndex(0);
    setError(null);
    returnView.current = null;
  }, [snapshotId]);

  const start = useCallback(
    (opts: { regenerate?: boolean } = {}) => {
      setStatus("loading");
      setError(null);

      const load = async (): Promise<void> => {
        // A cached tour costs nothing, so always look before generating — except
        // when the reader explicitly asked for a new one.
        const existing = opts.regenerate ? null : await getTour(snapshotId);
        const result = existing ?? (await generateTour(snapshotId, opts));

        returnView.current = viewRef.current.view;
        viewRef.current.setView(result.tour.view);

        setTour(result.tour);
        setModel(result.model);
        setIndex(0);
        setStatus("playing");
      };

      void load().catch((err: unknown) => {
        setStatus("error");
        setError(
          err instanceof ApiError
            ? err.message
            : "the tour could not be generated",
        );
      });
    },
    [snapshotId],
  );

  const total = tour?.steps.length ?? 0;

  const goTo = useCallback(
    (next: number) => {
      setIndex((current) => {
        if (next < 0 || next >= total) return current;
        return next;
      });
    },
    [total],
  );

  // Past the last stop, "next" ends the tour rather than sticking on the closer:
  // the closing stop already said goodbye, and a Next button that does nothing is
  // a button that says the tour is broken.
  const next = useCallback(() => {
    if (index >= total - 1) exit();
    else setIndex(index + 1);
  }, [index, total, exit]);

  const prev = useCallback(() => {
    setIndex((current) => Math.max(0, current - 1));
  }, []);

  // Keyboard, in both chromes — a tour you have to click through with a mouse is
  // a slideshow. Ignored while typing, so the search box still works.
  useEffect(() => {
    if (status !== "playing") return;

    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;

      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      } else if (e.key === "Escape") {
        e.preventDefault();
        exit();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status, next, prev, exit]);

  return {
    status,
    tour,
    model,
    error,
    step: status === "playing" ? (tour?.steps[index] ?? null) : null,
    index,
    total,
    start,
    next,
    prev,
    goTo,
    exit,
  };
}
