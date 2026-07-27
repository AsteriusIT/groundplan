import { defineConfig } from "vitest/config";

/**
 * The suite asserts on the **built** site (`pnpm test` runs `astro build`
 * first), because what a reader gets is the output: a claim that survives the
 * Markdown but is dropped by a component is still a claim on the page.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
