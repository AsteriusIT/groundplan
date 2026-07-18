import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useScrollSpy } from "./use-scroll-spy";

/** Captures constructed observers so tests can drive the callback by hand. */
class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  observed: Element[] = [];
  disconnected = false;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }

  observe(el: Element) {
    this.observed.push(el);
  }

  disconnect() {
    this.disconnected = true;
  }

  unobserve() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

function addSection(id: string): Element {
  const el = document.createElement("div");
  el.id = id;
  document.body.append(el);
  return el;
}

/** Only the fields the hook reads. */
function entry(
  target: Element,
  top: number,
  isIntersecting: boolean,
): IntersectionObserverEntry {
  return {
    target,
    isIntersecting,
    boundingClientRect: { top } as DOMRectReadOnly,
  } as IntersectionObserverEntry;
}

function fire(entries: IntersectionObserverEntry[]) {
  const observer = MockIntersectionObserver.instances[0];
  if (!observer) throw new Error("no observer constructed");
  act(() =>
    observer.callback(entries, observer as unknown as IntersectionObserver),
  );
}

beforeEach(() => {
  MockIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("starts on the first section", () => {
  addSection("a");
  addSection("b");
  const { result } = renderHook(() => useScrollSpy(["a", "b"]));
  expect(result.current).toBe("a");
});

it("is null for no sections", () => {
  const { result } = renderHook(() => useScrollSpy([]));
  expect(result.current).toBeNull();
});

it("stays on the first section where IntersectionObserver does not exist", () => {
  vi.unstubAllGlobals(); // back to bare jsdom
  addSection("a");
  addSection("b");
  const { result } = renderHook(() => useScrollSpy(["a", "b"]));
  expect(result.current).toBe("a");
});

it("observes each section element", () => {
  const a = addSection("a");
  const b = addSection("b");
  renderHook(() => useScrollSpy(["a", "b"]));
  expect(MockIntersectionObserver.instances[0]?.observed).toEqual([a, b]);
});

it("follows the section crossing the reading line", () => {
  addSection("a");
  const b = addSection("b");
  const { result } = renderHook(() => useScrollSpy(["a", "b"]));
  fire([entry(b, 12, true)]);
  expect(result.current).toBe("b");
});

it("gives ties to the section highest on screen", () => {
  const a = addSection("a");
  const b = addSection("b");
  const { result } = renderHook(() => useScrollSpy(["a", "b"]));
  fire([entry(b, 140, true), entry(a, 16, true)]);
  expect(result.current).toBe("a");
});

it("keeps the last section while none intersect", () => {
  addSection("a");
  const b = addSection("b");
  const { result } = renderHook(() => useScrollSpy(["a", "b"]));
  fire([entry(b, 12, true)]);
  fire([entry(b, -400, false)]);
  expect(result.current).toBe("b");
});

it("disconnects on unmount", () => {
  addSection("a");
  const { unmount } = renderHook(() => useScrollSpy(["a"]));
  unmount();
  expect(MockIntersectionObserver.instances[0]?.disconnected).toBe(true);
});
