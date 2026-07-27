import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";

import remarkProductName, {
  substituteProduct,
} from "./plugins/remark-product-name";
import { DOCS_URL, PRODUCT, REPO_URL } from "./src/product";
import { SIDEBAR } from "./src/sidebar";

/**
 * The documentation site (GP-213). Static output only, like the marketing site.
 *
 * `site` is the domain the docs are served from; canonical URLs and the search
 * index derive from it. The site stays out of every index until the trademark
 * gate (GP-166) clears — see `public/robots.txt` and the `noindex` head tag.
 */
export default defineConfig({
  site: DOCS_URL,
  markdown: {
    processor: unified({ remarkPlugins: [remarkProductName] }),
  },
  integrations: [
    starlight({
      title: substituteProduct("%PRODUCT% docs"),
      description: substituteProduct(
        "Install %PRODUCT% and use it: self-hosting, CI integration, visual pull-request review, living documentation and lenses.",
      ),
      logo: { src: "./src/assets/logo.svg", alt: PRODUCT, replacesTitle: false },
      favicon: "/favicon.svg",
      customCss: ["./src/styles/docs.css"],
      // Starlight ships light and dark; the product's identity is the carbon
      // dark theme, and a docs site that flips palettes beside product
      // screenshots taken in carbon reads as two products (GP-158's choice).
      head: [{ tag: "meta", attrs: { name: "robots", content: "noindex, nofollow" } }],
      social: [{ icon: "github", label: "GitHub", href: REPO_URL }],
      editLink: { baseUrl: `${REPO_URL}/edit/main/apps/docs/` },
      lastUpdated: false,
      credits: false,
      pagination: true,
      sidebar: SIDEBAR,
    }),
  ],
});
