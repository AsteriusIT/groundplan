/**
 * The one place the product is named (GP-213).
 *
 * "Groundplan" is a working name, not a cleared one — the trademark gate
 * (GP-166) is still open, which is also why the whole site is `noindex`. So the
 * name never appears in a Markdown file: pages write `%PRODUCT%` and the remark
 * plugin in `plugins/remark-product-name.ts` substitutes this constant at build
 * time. Renaming the product is editing the two strings below.
 *
 * What is NOT a brand and therefore stays literal in the content:
 *   - `@asteriusit/cli` and its `groundplan` binary — a published npm package
 *   - `GROUNDPLAN_URL` / `GROUNDPLAN_TOKEN` / `X-Groundplan-Token` — the wire
 *     contract a running pipeline depends on
 *   - image names, chart names, realm names — deployment identifiers
 * Renaming those is a product change, not a website change.
 */
export const PRODUCT = "Groundplan";

/** Lowercase form, for prose that starts mid-sentence in a code-ish context. */
export const PRODUCT_ID = "groundplan";

/** Where the documentation itself is served. */
export const DOCS_URL = "https://doc.asteriusit.fr";

/** The marketing site — the docs link there for the "why", never repeat it. */
export const WEBSITE_URL = "https://www.asteriusit.fr";

/** The public source repository. */
export const REPO_URL = "https://github.com/AsteriusIT/groundplan";
