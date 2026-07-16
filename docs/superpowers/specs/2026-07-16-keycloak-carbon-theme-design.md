# groundplan Keycloak theme (carbon) — design

**Date:** 2026-07-16
**Status:** approved, implementing (phased: login → account → email)

## Goal

Replace Keycloak's stock login/account/email UI — the pages a groundplan user
actually sees during OIDC sign-in — with a theme that matches the app's **carbon**
palette (near-neutral graphite-black dark theme). Built as a **Keycloakify v11**
project so the pages are React + Tailwind v4 + shadcn/ui, mirroring the frontend
stack exactly.

## Decisions (locked)

- **Scope:** login **+** account **+** email themes, all named `groundplan`.
- **Modes:** carbon **dark only** (the app's carbon tokens flattened to a single
  `:root`; no light/system switching).
- **Integration:** wired into `docker-compose.yml` + `infra/keycloak/groundplan-realm.json`
  and **verified live** in a browser.
- **Location:** top-level `keycloak/` folder, added to the pnpm workspace as
  `@groundplan/keycloak-theme`.

## Stack

- Keycloakify **11.15.x** (Vite plugin), Vite 6, React 19, TypeScript strict
  (extends `tsconfig.base.json`).
- Tailwind CSS **v4** via `@tailwindcss/vite`; shadcn/ui **new-york / neutral**,
  `@/` alias, `cn()` helper — identical to the frontend.
- Fonts from the same `@fontsource` packages (Space Grotesk / Inter / IBM Plex
  Mono), bundled into the jar so Keycloak serves them offline.
- Build packaged as a Keycloak **provider jar** (host has JDK 25 + keytool).

## Palette — carbon, flattened

The app layers carbon as `.dark` + `.dark[data-theme="carbon"]`. Because this
theme is dark-only, both layers are flattened into one `:root` in
`keycloak/src/index.css`, with the same `@theme inline` mapping so every shadcn
utility (`bg-card`, `text-muted-foreground`, `border-input`, …) resolves
identically. Key values: bg `#0c0d10`, card `#17191f`, border `#23262d`, ink
`#e8eaed`, muted-ink `#9aa0aa`, primary `#4c8dff`, status create/update/delete
`#2ec77e`/`#e0a020`/`#f0604d`. A `design-tokens.test.ts` guard forbids hardcoded
hex in components, matching the frontend.

## Structure

```
keycloak/
├── package.json  vite.config.ts  vitest.config.ts  tsconfig.json  components.json  index.html
└── src/
    ├── index.css            # flattened carbon tokens + @theme + fonts + tailwind
    ├── lib/utils.ts         # cn()
    ├── components/ui/       # ported shadcn: button, input, label, card, alert
    ├── kc.gen.tsx           # generated (keycloakify update-kc-gen); do not hand-edit
    ├── main.tsx             # dev-preview entry (mock kcContext)
    ├── login/  Template.tsx (carbon shell) + KcPage + KcContext + i18n + pages/
    ├── account/ Template.tsx + KcPage + pages/    (phase 3)
    └── email/               # FreeMarker templates, carbon header, email-safe CSS (phase 4)
```

## Approach per theme

- **Login (phase 1, verified first):** one strong `Template.tsx` (carbon
  background, centered card, groundplan wordmark in Space Grotesk, tagline,
  footer) wraps every login page; `Login.tsx` fully styled (username/password,
  remember-me, forgot-password, social providers). Register / reset-password /
  OTP / verify-email / error / info / page-expired inherit the shell + shared
  shadcn form primitives and are spot-styled. `doUseDefaultCss: false` so Tailwind
  fully owns styling.
- **Account (phase 3):** Keycloakify account theme; the exact v11 mechanism
  (Multi-Page React pages vs Single-Page Account UI) is confirmed against the
  installed Keycloakify + Keycloak 26 at implementation time, then themed with the
  same Template + primitives.
- **Email (phase 4):** emails are server-rendered HTML — no Tailwind/React at send
  time — so these are **FreeMarker templates** with inline, email-client-safe CSS:
  a carbon-branded header band + readable body. Scope: verify-email and
  reset-password plus the shared html/text wrappers.

## Integration & verification

- `docker-compose.yml`: mount the built jar into Keycloak's `/opt/keycloak/providers/`.
- `infra/keycloak/groundplan-realm.json`: set `loginTheme` / `accountTheme` /
  `emailTheme` = `"groundplan"`.
- Root script `pnpm keycloak:build`; `pnpm-workspace.yaml` glob updated.
- Verify: build jar → `docker compose --profile auth up -d` → drive the real login
  page in a browser and confirm the carbon UI renders. Ordering constraint: the
  jar must exist before Keycloak starts.

## Risks / to confirm during build

- Keycloakify jar packaging needs a JDK/keytool on the host — **confirmed present**
  (JDK 25).
- Keycloak 26 account-theme mechanism (Multi-Page account-v1 may be deprecated) —
  confirm and adapt in phase 3.
- Tailwind v4 CSS scoping inside Keycloak's FreeMarker shell — own the reset,
  `doUseDefaultCss: false`.
- React 19 vs Keycloakify peer range (^18) — runtime-compatible; resolve any type
  friction, fall back to React 18 only if needed.
