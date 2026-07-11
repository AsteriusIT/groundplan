# Resource icons (GP-29)

Groundplan draws a per-resource-type icon on every node. This document records
what those icons are, where they come from, and the licensing decision behind
them.

## What ships in the repo

Original, in-house **blueprint line-glyphs** for the common Azure service
families, authored to a 24×24 grid and inlined as path data in
[`src/icons/azure-glyphs.tsx`](src/icons/azure-glyphs.tsx). They are drawn with
`stroke: currentColor` so they tint with the node's category colour, matching the
lucide category icons and the blueprint theme. Total footprint is a few KB of
path data (well under the 150 KB budget) — no per-file asset requests, no bundler
config.

These are **our own artwork**, released under the same licence as this
repository. They are not Microsoft's icons.

## Why not Microsoft's official Azure Architecture Icons?

The Azure Architecture Icons are Microsoft's official set and are the natural
choice for a diagram tool. However, their
[Terms of Use](https://learn.microsoft.com/en-us/azure/architecture/icons/)
permit using the icons **within** architecture diagrams and documentation but
**do not permit redistributing the icon files themselves** (for example,
committing the SVGs into a source repository or shipping them as an icon
library). Vendoring ~40 of the official SVGs into this repo would be exactly that
kind of redistribution.

The ticket asked us to *read and respect the usage guidelines*. Respecting them
means we do **not** vendor the proprietary set here. Instead we ship
licence-clean originals and keep the official set as an optional, local drop-in.

- Official set + terms: <https://learn.microsoft.com/en-us/azure/architecture/icons/>

## The mapping mechanism (provider-generic)

The interesting engineering is the resolution chain, and it is provider-generic —
Azure is just the first (demo) provider.

- [`src/icons/azurerm.ts`](src/icons/azurerm.ts) — `AZURERM_ICON_MAP` (exact
  `azurerm_*` type → glyph, ~40 types covering the example repo) and
  `AZURERM_PREFIX_MAP` (type-prefix → glyph heuristic).
- [`src/icons/resource-icon.ts`](src/icons/resource-icon.ts) —
  `resolveResourceIcon(type)`, a pure, unit-tested function implementing the
  chain: **exact type → type-prefix heuristic → category icon (GP-24) → generic
  cube.** Only `azurerm_*` types try the Azure glyphs; any other provider falls
  back to its category icon.
- [`src/components/resource-icon.tsx`](src/components/resource-icon.tsx) — the
  `<ResourceIcon type=… />` renderer.

Adding AWS/GCP later is a new `aws.ts` / `google.ts` map plus a branch in the
resolver — the icon assets are the only thing that changes.

## Swapping in the official Azure set (optional, local)

If you want the official coloured Azure icons in a local build (respecting the
terms — do not commit them):

1. Download the official set from the link above.
2. Drop the SVGs into an (git-ignored) `src/icons/azure/official/` folder.
3. Point `AZURERM_ICON_MAP` values at those filenames and swap `ResourceIcon`'s
   glyph branch to load them. The mapping and resolution chain stay exactly as
   they are.
