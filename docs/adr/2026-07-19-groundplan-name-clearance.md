# ADR: "Groundplan" trademark & name clearance — NO-GO for the public name

- **Status:** Accepted (clearance executed; rename decision pending)
- **Date:** 2026-07-19
- **Story:** GP-166 (gates the public launch of GP-158..GP-165)
- **Evidence:** `docs/adr/evidence-gp166/` (register screenshots + RDAP/npm/GitHub captures, all taken 2026-07-19)

## Context

"groundplan" has been the working name for the repo, CLI and VS Code extension.
`docs/vscode-publishing.md` and the marketing-website epic (GP-157) both list a
trademark check as a pre-launch gate: the site is built and staged behind a
noindex robots policy until this ADR clears the name. This ADR records the
search that was parked, with evidence committed to the repo.

## What the search found

### Trademark registers

| Register | Mark | Status | Classes | Holder | Ref |
| --- | --- | --- | --- | --- | --- |
| USPTO | GROUNDPLAN | **Live / Registered** | **9, 42** (downloadable software, …) | Redden Family Holdings Pty Ltd (AU) | serial 79421394 |
| USPTO | GROUNDPLAN | Live / Pending | 3 (cosmetics) | Barinu Co Ltd (KR) | serial 98202234 |
| WIPO (international) | groundplan | **Registered** (2025-03-12) | **9, 42** | Redden Family Holdings Pty Ltd | 1849258 |
| New Zealand | GROUNDPLAN | **Registered** (2021) | **9, 42** | Carvalho Family Holdings / Redden | 1181350 |
| Australia (IPA) | groundplan | **Registered** (2023) | **42** | Carvalho Family Holdings Pty Ltd | 2411188 |
| Australia (IPA) | GROUNDPLAN | Ended (2021) | 9, 42 | 3 Stack Pty Ltd | 2179888 |

TMview returns 13 hits in total for "groundplan" (screenshot committed); the
rows above are the ones in software classes or live. The IP Australia portal
blocks headless capture, but its records appear in TMview (5 AU hits).

The class-9/42 registrant is **Groundplan Software** (groundplan.com — cloud
takeoff & estimating SaaS for construction trades, "8,000+ contractors across
Australia, NZ and beyond"). An identical name, in the same Nice classes we
would file in (9/42, SaaS), held by an active software company with a 2025
WIPO international registration that designates the US. This is not an
ambiguous result, so per the story's guidance no lawyer is needed to read it:
offering a SaaS named "Groundplan" would invite a likelihood-of-confusion
claim in every market that matters to us.

### Name conflicts beyond trademarks (checked same day)

- **npm:** the package name `groundplan` was published **2026-07-19** (hours
  before this search) by a third party ("Groundplan CLI — pick an architecture,
  assemble it from templates, wire it for AI coding tools", maintainer
  `noureddin666`). An unrelated developer tool now actively uses the name.
- **GitHub:** the org `groundplan` was created **2026-07-19** (repo
  `opengroundplan`). Unavailable.
- **npm scope `@groundplan`:** no packages published, but the org page is not
  claimable by us if the org owner registered it; treat as unavailable.
- **Domains (RDAP):** `groundplan.com` registered since **2001** (the senior
  user), `.dev` since 2023, `.app` since 2026-04. `groundplan.io`, `.net`,
  `.cloud` and `getgroundplan.com` were unregistered on 2026-07-19 — moot
  given the decision below.

## Decision

**NO-GO.** "Groundplan" must not be the public, marketed product name. The
senior user is an active software company holding live registrations in
classes 9 and 42 in the US, Australia and New Zealand plus a 2025 WIPO
international registration, and the surrounding namespace (npm, GitHub org,
.com/.dev/.app) is already taken.

Consequences, effective now:

1. The marketing site **stays noindex** (already enforced by test in
   `apps/website`) and must not launch publicly under this name.
2. The VS Code Marketplace / npm publishing steps that would print the name
   publicly stay gated (`docs/vscode-publishing.md` already lists this).
3. Internal use (repo name, `GP-*` ticket prefix, dev artifacts) may continue
   short-term — it is not marketed trade use — but the rename should land
   before any public artifact ships.

## Fallback name

A new public name must be **decided by the founder** — a brand choice this ADR
deliberately does not make. Practical inputs for that decision:

- The earlier working name **InfraCanvas** is the natural first candidate, but
  it must pass this exact same clearance (TMview + USPTO + npm + GitHub +
  domains) before adoption — do not assume it is clean.
- Whatever the choice, re-run the checks in `docs/adr/evidence-gp166/` style
  and record a follow-up ADR, then flip the site's robots policy (one test in
  `apps/website/src/site.test.ts` pins it) and update the wordmark copy.

## How this was searched (reproducible)

- USPTO tmsearch.uspto.gov, wordmark query `groundplan` (screenshot).
- TMview (tmdn.org), trade-mark name contains `groundplan`, all offices
  (screenshot; includes AU-IPA, CIPO, DPMA, WIPO, USPTO rows).
- RDAP via rdap.org for the domains listed above (JSON committed).
- npm registry document for `groundplan` (slimmed JSON committed) and GitHub
  `GET /orgs/groundplan` (JSON committed).
