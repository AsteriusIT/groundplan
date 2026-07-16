import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { setActiveOrgProvider } from "@/api/client";

// Unmount React trees between tests so they don't leak into each other.
afterEach(() => {
  cleanup();
});

// Give the API client a default active org (GP-117) so the real URL builders
// (`aiCompletionUrl`, `getSnapshotExport`) don't throw in component tests that
// mock the JSON client but reach a builder directly. Tests that care about the
// org can override via their own OrgProvider/OrgContext.
setActiveOrgProvider(() => "test-org");

// --- jsdom polyfills for Radix UI (Dialog, etc.) ---------------------------
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
      // no-op: jsdom stub, ResizeObserver never fires in tests
    }
    unobserve() {
      // no-op: jsdom stub, ResizeObserver never fires in tests
    }
    disconnect() {
      // no-op: jsdom stub, ResizeObserver never fires in tests
    }
  };
}

Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
