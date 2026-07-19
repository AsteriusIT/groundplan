# @groundplan/canvas

The Groundplan diagram canvas as a reusable React package (GP-146): React Flow
+ ELK layout + the design-v3 nodes/edges + blueprint theme + vendor icons +
search / neighborhood highlight. Consumed by the web app (through thin
re-export shims at the old `@/…` paths) and by the VS Code webview (GP-147).
Workspace-internal; ships as **source** — every consumer is a bundler (Vite),
so there is no build step.

## Usage

```tsx
import { GraphCanvas, type Graph } from "@groundplan/canvas";
import "@groundplan/canvas/styles.css"; // tokens + fonts + utilities — all of it

<GraphCanvas
  graph={snapshot.graph}
  variant="docs"
  onNodeSelect={(node) => …}   // user selection out (null = cleared)
  selectedAddress={address}    // controlled selection in (never echoed back)
/>;
```

- The component is controlled-data: snapshot in via `graph`, events out.
  Annotations, tours, network containers and filters are all optional props —
  a bare `graph` renders the plain docs diagram.
- `styles.css` is self-contained: design tokens (the copy is guarded against
  drift by the app's `design-tokens.test.ts`), self-hosted fonts, and Tailwind
  utilities generated from this package's sources only. One import styles a
  bare webview. Themes are the host's job: put `class="dark"` (blueprint) or
  `class="dark" data-theme="carbon"` on the root element, or nothing (light).
- Icons are bundled SVG assets resolved with `import.meta.glob` — a Vite
  consumer emits and hashes them; nothing is fetched at runtime.

## Sandbox (webview-readiness proof)

`pnpm --filter @groundplan/canvas dev` serves a page that renders a fixture
snapshot with only the package import + its CSS; `sandbox:build` builds it.

## Commands

```sh
pnpm --filter @groundplan/canvas test        # vitest + jsdom
pnpm --filter @groundplan/canvas typecheck
pnpm --filter @groundplan/canvas dev         # sandbox
```
