// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// Static output only (GP-158). `site` is the staging origin until the
// trademark gate (GP-166) clears and a real domain replaces it; sitemap and
// canonical URLs derive from it.
export default defineConfig({
  site: "https://www.groundplan.qcs.ovh",
  vite: {
    plugins: [tailwindcss()],
  },
});
