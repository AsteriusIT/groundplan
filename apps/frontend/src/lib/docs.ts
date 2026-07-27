/**
 * Where the documentation lives, and the pages the app links into.
 *
 * One module, for the same reason `src/api/client.ts` is one module: a URL
 * pasted into a component is a URL nobody can find again. The trademark gate
 * (GP-166) will move this origin, and a rebranding should be one edit rather
 * than a search across the app.
 *
 * The keys are **destinations**, not paths — a page renamed on the docs site
 * changes one line here and nothing in any component. Every value is a route the
 * docs site actually builds (its own suite fails on a link with no page).
 */
const DOCS_ORIGIN = "https://doc.asteriusit.fr";

export const DOC_PAGES = {
  home: "/",
  concepts: "/concepts/",
  quickstart: "/quickstart/",
  ci: "/ci/",
  cli: "/ci/cli/",
  kubernetesManifests: "/ci/kubernetes/",
  liveClusters: "/use/live-clusters/",
  pullRequests: "/use/pull-requests/",
  annotations: "/use/annotations/",
  policies: "/use/policies/",
  driftAndReality: "/use/drift-and-reality/",
  exports: "/use/exports/",
  playground: "/use/playground/",
  integrations: "/admin/integrations/",
  troubleshooting: "/help/troubleshooting/",
} as const;

export type DocPage = keyof typeof DOC_PAGES;

/** Absolute URL of a documentation page. */
export function docsUrl(page: DocPage): string {
  return `${DOCS_ORIGIN}${DOC_PAGES[page]}`;
}
