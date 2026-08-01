import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Unmount React trees between tests so they don't leak into each other.
afterEach(() => {
  cleanup();
});

// --- jsdom polyfills ------------------------------------------------------
// The panel measures itself (the responsive tiers) and mounts Radix popovers;
// jsdom implements neither. Same stubs the canvas package uses.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {
      // no-op: jsdom stub, ResizeObserver never fires on its own in tests
    }
    unobserve() {
      // no-op
    }
    disconnect() {
      // no-op
    }
  };
}

Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
