/**
 * How much room the toolbar has, as a value rather than a stylesheet.
 *
 * The obvious instinct is a container query, and it would be right if the
 * difference between tiers were cosmetic. It is not: a narrow panel moves
 * controls *into* a menu and turns the lens segments into a dropdown, and CSS
 * can only do that by rendering both forms and hiding one — which doubles the
 * DOM, duplicates every id and label, and hands a screen reader two copies of
 * the same toolbar. So the width is measured and the structure follows.
 *
 * Measured on the panel, not the window: the preview opens beside the editor
 * and can be dragged to any width, so a media query answers a question nobody
 * asked.
 */
import { useEffect, useState, type RefObject } from "react";

export type Tier = "wide" | "medium" | "narrow";

/** Everything visible. */
const WIDE_FROM = 640;
/** Segments kept; search and chips compact. */
const MEDIUM_FROM = 480;

export function tierFor(width: number): Tier {
  // Zero means "not measured yet". Assuming narrow would collapse the toolbar
  // for a frame on every open, which reads as a glitch rather than a layout.
  if (width === 0) return "wide";
  if (width >= WIDE_FROM) return "wide";
  if (width >= MEDIUM_FROM) return "medium";
  return "narrow";
}

/** The tier of an element, kept current as it is resized. */
export function useTier(ref: RefObject<HTMLElement | null>): Tier {
  const [width, setWidth] = useState(0);
  const element = ref.current;

  // `element` is a dependency, not just a read: the panel swaps its root
  // between the loading, empty and diagram states, and an effect keyed only on
  // the ref object would keep observing the node that was replaced.
  useEffect(() => {
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return tierFor(width);
}
