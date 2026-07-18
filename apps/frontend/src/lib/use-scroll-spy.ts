import { useEffect, useState } from "react";

/**
 * Which of the given section ids is nearest the top of the scroll viewport.
 * The "reading line" is the top 40% of the screen (rootMargin trims the
 * bottom 60%); among sections crossing it, the highest on screen wins, and
 * when none do — between sections, or past the end — the last answer holds.
 *
 * jsdom has no IntersectionObserver: the hook then reports the first id and
 * never updates, so component tests exercise the markup, not the browser.
 */
export function useScrollSpy(ids: readonly string[]): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  const key = ids.join("|");

  useEffect(() => {
    const sections = key === "" ? [] : key.split("|");
    setActive(sections[0] ?? null);
    if (sections.length === 0 || typeof IntersectionObserver === "undefined") {
      return;
    }

    const tops = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            tops.set(entry.target.id, entry.boundingClientRect.top);
          } else {
            tops.delete(entry.target.id);
          }
        }
        const highest = [...tops.entries()].sort((a, b) => a[1] - b[1])[0];
        if (highest) setActive(highest[0]);
      },
      { rootMargin: "0px 0px -60% 0px" },
    );

    for (const id of sections) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [key]);

  return active;
}
