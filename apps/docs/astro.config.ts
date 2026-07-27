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
      //
      // Single-theme is enforced at the source: `ThemeProvider` pins
      // `data-theme="dark"` instead of reading the visitor's OS preference.
      //
      // The palette in `src/styles/docs.css` was carbon either way, but the code
      // blocks were not: Expressive Code emits a colour pair per token and picks
      // between them on `data-theme`, so a visitor whose OS is in light mode got
      // light-theme tokens on our permanently dark code blocks — unreadable, and
      // a genuine contrast failure rather than an audit technicality.
      //
      // Pinning the attribute rather than setting `expressiveCode.themes` is
      // deliberate: that option makes this Starlight/Expressive Code pair emit
      // one stylesheet hash and link another, so the code blocks ship unstyled.
      // `ThemeSelect` then renders nothing, because a control that changes
      // nothing is worse than a missing one.
      components: {
        ThemeProvider: "./src/components/ThemeProvider.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
      },
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
