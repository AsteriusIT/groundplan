# Documentation site (GP-212 epic, GP-213..GP-225) — design

A public documentation site on `doc.asteriusit.fr` answering the only two
questions a user has: **how do I install it** and **how do I use it**. Today
that knowledge lives in `CLAUDE.md`, README files, `docs/` and Jira — unusable
by anyone outside the repository, and the first brake on self-host adoption.

The marketing site (GP-157) **sells**; the documentation **explains**. Neither
repeats the other: the docs link to the site for the "why", the site links to
the docs for the "how".

## Architecture

A new workspace app, `apps/docs` — Astro + Starlight, static output only, the
same shape `apps/website` already has (Dockerfile → nginx → the Caddy edge).

| Decision | Why |
| --- | --- |
| Starlight, not a hand-rolled layout | Sidebar, client search (Pagefind), previous/next, heading anchors and a11y for free. Astro is already known here. |
| Tokens copied, not shared | Same choice as GP-158: a token package would couple three builds for eleven colours. `src/styles/docs.css` copies the carbon values. |
| One product name constant | `src/product.ts` exports `PRODUCT`; Markdown writes `%PRODUCT%` and a 20-line remark plugin substitutes it. GP-166 rebranding = one line. |
| Markdown in the monorepo | The doc lives beside the code it describes: a PR that adds an env var edits its documentation page in the same PR. The only discipline that stops a doc rotting. |
| English only, one version | Same language as the product, the CLI and the marketing site. No version switcher, no i18n, no CMS, no analytics. |

## Information architecture

Two journeys, eight sidebar groups:

```
Get started   Welcome · Concepts · Quickstart
Install       Docker Compose · Kubernetes (Helm) · Helm values
Connect CI    CI integration · CLI reference · Kubernetes manifests
Use           Pull requests · Living documentation · Lenses · Annotations ·
              Policies · Drift & reality · Exports & sharing · Live clusters ·
              Playground · VS Code
AI (optional) The AI layer · AI Studio
Administer    Organizations & roles · Integrations · Security posture
Reference     Configuration · OIDC · Encryption key
Help          Troubleshooting · Known limits · FAQ
```

Policies (GP-199..204) and Drift & reality (GP-205..210) are not named in the
epic — it was written before they shipped. Documenting them is the same rule as
everything else: what exists is documented, or the site is already lying.

## Guard-rails (CI)

The doc must not rot and must not lie. Four gates, all in
`.github/workflows/docs.yml` and all runnable locally:

1. **Build** — `pnpm --filter @groundplan/docs build`.
2. **Honesty test** — a vitest suite over the built `dist`: a forbidden-phrase
   list (cost estimate, pricing, emailed invitations…) plus context rules
   ("AI Studio" only on a page that also says *experimental*; the network/IAM
   lenses only on a page that also says *Azure-first*).
3. **Env coverage test** — every `process.env.X` read by
   `apps/backend/src/config/env.ts` must have a row in the configuration
   reference. Adding a variable without documenting it breaks CI.
4. **Link check** — internal links resolved against the built file tree
   (offline, deterministic); external links checked by lychee in CI.

Plus `robots.txt: Disallow: /` and a `noindex` meta on every page until GP-166
clears, mirroring the marketing site.

## Surfacing the docs inside the product

Documentation nobody finds is documentation nobody reads. One module,
`apps/frontend/src/lib/docs.ts`, holds the site origin and a typed map of page
paths; the app links to it from the places where a user is actually stuck —
the account menu, the CI setup block, the cluster dialog, the drift panel, the
policies page. No page ships its own URL string.

## Out of scope

Generated REST API reference, i18n, multi-version, contributor/architecture
docs (they stay in the repo), video, hosted search, automated changelog,
analytics.
