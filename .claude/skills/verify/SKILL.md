---
name: verify
description: Run groundplan end-to-end (Postgres + Keycloak + backend + frontend) and drive the real UI in a browser to observe a change working.
---

# Verifying a change in groundplan

The product is a React SPA behind OIDC talking to a Fastify API. The only honest
surface for a frontend story is **the browser, logged in**. For a backend story
it is **an authenticated HTTP call**.

## Bring the stack up

```bash
docker compose --profile auth up -d   # Postgres :5432 + Keycloak :8085
pnpm dev                              # backend :3000, frontend :5173
```

`pnpm dev` fails with `EADDRINUSE` when a dev server is already running — that is
fine, it means the stack is up and `tsx watch` / Vite HMR already picked up your
changes. Check with `curl -s localhost:3000/healthz`.

Dev defaults (`config/env.ts`, `src/config.ts`) already point at the dockerized
Keycloak, so no env setup is needed.

## Call the API directly

The realm's dev user is `dev` / `dev`, and the frontend client allows the
password grant — so a token is one curl away:

```bash
TOKEN=$(curl -s -X POST http://localhost:8085/realms/groundplan/protocol/openid-connect/token \
  -d grant_type=password -d client_id=groundplan-frontend -d username=dev -d password=dev \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

curl -s -H "Authorization: Bearer $TOKEN" localhost:3000/api/v1/dashboard | python3 -m json.tool
```

## Drive the UI

There is no Playwright in the repo — install it in the scratchpad. The cached
playwright browsers do not match the package version, so point it at the system
Chrome:

```js
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
```

Login flow to replay before every UI observation:

```js
await page.goto("http://localhost:5173/");           // RequireAuth → /login
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForURL(/localhost:8085/);             // Keycloak
await page.fill("#username", "dev");
await page.fill("#password", "dev");
await page.click("#kc-login");
await page.waitForURL(/localhost:5173/);
```

To reach states the dev database doesn't hold (fresh user, an API failure,
orphaned annotations), intercept the call instead of mutating data:
`page.route("**/api/v1/dashboard", (r) => r.fulfill({ ... }))`.

## Gotchas

- **React StrictMode double-fetches in dev.** A page's `useEffect` load runs
  twice, so an interception that fails only the *first* call is immediately
  healed by the second. Fail every call until you deliberately flip it.
- **The test suite shares the dev database** (same `DATABASE_URL`). Counts and
  "recent" lists in dev are polluted by test fixtures (`acme/infra`, `sha-docs`,
  dozens of throwaway projects). Don't read that as a bug in the code under test.
