# Resource icons (GP-29)

Groundplan draws a per-resource-type icon on every node. This document records
what those icons are, where they come from, and the licensing basis for shipping
them.

## What ships in the repo

The **official Microsoft Azure Architecture Icons, set V24**, for the common
Azure service families. Only the ~30 icons we map are committed, under
[`src/icons/azure/`](src/icons/azure/) with clean kebab-case filenames (e.g.
`virtual-network.svg`, `storage-account.svg`). They are the original Microsoft
SVGs, **unmodified** — renamed only, never edited.

- Source: <https://learn.microsoft.com/en-us/azure/architecture/icons/> (the
  `Azure_Public_Service_Icons_V24` download).
- Total footprint ~128 KB of SVG; Vite emits each as its own hashed asset, so
  only the committed icons ship.

## Licensing

Microsoft's [Azure architecture icon terms](https://learn.microsoft.com/en-us/azure/architecture/icons/)
permit using the icons **to create architecture diagrams, including diagrams
displayed in a web application**, provided the icons are **not modified**
(no recolouring, no changes to proportions, no added effects). Groundplan renders
infrastructure architecture diagrams, which is exactly this use, and it renders
each icon **as-is via an `<img>`** — so the SVG is never recoloured or altered.
The project owner reviewed and accepted this use.

Do **not** edit the SVGs in `src/icons/azure/`, and do not repurpose them as a
standalone icon library outside the diagram views.

## The mapping mechanism (provider-generic)

Azure is the first (demo) provider; the mechanism is provider-generic.

- [`src/icons/azurerm.ts`](src/icons/azurerm.ts) — `AZURERM_ICON_MAP` (exact
  `azurerm_*` type → icon, ~40 types) and `AZURERM_PREFIX_MAP` (type-prefix →
  icon heuristic).
- [`src/icons/resource-icon.ts`](src/icons/resource-icon.ts) —
  `resolveResourceIcon(type)`, a pure, unit-tested function implementing the
  chain **exact type → type-prefix heuristic → category icon (GP-24) → generic
  cube.** Only `azurerm_*` types try the Azure icons; any other provider falls
  back to its lucide category icon, then a cube.
- [`src/icons/azure-icons.ts`](src/icons/azure-icons.ts) — resolves an icon key
  to its bundled asset URL (`import.meta.glob` over `./azure/*.svg`).
- [`src/components/resource-icon.tsx`](src/components/resource-icon.tsx) — the
  `<ResourceIcon type=… />` renderer.

Adding AWS/GCP later is a new `aws.ts` / `google.ts` map (pointing at that
provider's official icon set) plus a branch in the resolver.

## Fallbacks

- **Unmapped `azurerm_*` type** → nearest family via the prefix heuristic, else
  the lucide category icon (compute/network/data/…), else a cube.
- **Non-Azure provider** (`aws_*`, `google_*`) → lucide category icon, else cube.

The lucide fallbacks are colour-tinted by category token; only the official Azure
icons are rendered unmodified.
