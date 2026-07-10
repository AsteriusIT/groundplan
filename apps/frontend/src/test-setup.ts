import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Unmount React trees between tests so they don't leak into each other.
afterEach(() => {
  cleanup();
});
