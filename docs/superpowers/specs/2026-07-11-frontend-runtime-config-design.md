# Frontend runtime `config.json` — design

## Problem

The frontend's public configuration — the API base URL and OIDC settings — is
inlined into the JavaScript bundle at **build time**. Vite replaces
`import.meta.env.VITE_*` with literal values during `pnpm build`, and the
Dockerfile passes those values as build args:

- `VITE_API_URL` — read as a module-level `const` in `src/api/client.ts`.
- `VITE_OIDC_ISSUER`, `VITE_OIDC_CLIENT_ID`, `VITE_OIDC_REDIRECT_URI` — read
  inside `createUserManager()` in `src/auth/user-manager.ts`.

Consequence: the image is **not portable across environments**. Pointing the SPA
at a different API origin or OIDC issuer requires rebuilding the image. This
contradicts the build-once/deploy-anywhere model the rest of the production
stack follows (`docker-compose.prod.yml` configures every other service via
runtime environment).

## Goal

Serve the same built image everywhere. Configure each environment at **runtime**
by mounting a `config.json` file that the SPA fetches on startup. No rebuild per
environment.

Non-goals: templating `config.json` from environment variables via a container
entrypoint (considered and rejected in favor of a simpler static mounted file);
changing any backend behavior; adding a config UI.

## Approach (chosen)

The SPA fetches `/config.json` from its own origin at startup, before rendering.
In production the operator **mounts a static `config.json`** into the nginx html
root, overriding the default baked into the image. This keeps the image free of
startup scripting; configuration is a plain JSON file edited per environment.

## Design

### 1. Config module — `src/config.ts` (new)

Single source of runtime-config truth for the frontend.

```ts
export type AppConfig = {
  apiUrl: string;            // API origin; "" = same-origin (/api via proxy/edge)
  oidcIssuer: string;        // OIDC authority
  oidcClientId: string;      // OIDC client id
  oidcRedirectUri?: string;  // optional; falls back to `${origin}/callback`
};

const DEFAULT_CONFIG: AppConfig = {        // current dev defaults, verbatim
  apiUrl: "",
  oidcIssuer: "http://localhost:8085/realms/groundplan",
  oidcClientId: "groundplan-frontend",
};
```

- `loadConfig(): Promise<AppConfig>` — `fetch("/config.json")`. On a 2xx JSON
  response, tolerantly merge each **known** key over `DEFAULT_CONFIG` (unknown
  keys ignored, missing keys keep their default, non-string values ignored). On
  **any** failure (non-2xx, network error, invalid JSON), `console.warn` and
  keep `DEFAULT_CONFIG`. Stores the result in a module singleton.
- `getConfig(): AppConfig` — returns the singleton. The singleton is initialized
  to `DEFAULT_CONFIG`, so reads are always safe even before `loadConfig()`
  resolves (matters for tests and for any accidental early read).
- `setConfig(cfg: AppConfig): void` — overwrite the singleton. Used by
  `loadConfig()` and by tests.

Rationale for tolerant merge + safe default: dev and tests must work with **zero
setup** and no white-screen if `config.json` is missing or malformed.

### 2. Bootstrap — `src/main.tsx`

`await loadConfig()` **before** `createRoot(...).render(...)`. This guarantees
the config singleton is populated before `AuthProvider` mounts or any API call
fires. The existing render call moves inside an async bootstrap.

### 3. Consumers switch to lazy reads

- **`src/api/client.ts`**: the module-level `const API_ROOT` / `const API_BASE`
  become `getApiRoot()` / `getApiBase()` helpers that read `getConfig().apiUrl`
  on each call. This is required because a `const` evaluated at import time would
  capture `DEFAULT_CONFIG` before the `loadConfig()` fetch resolves. Callers
  updated: `request`, `getSnapshotExport`, `webhookUrl`, `publicExportUrl`,
  `shareUrl`.
- **`src/auth/user-manager.ts`**: `createUserManager()` reads `getConfig()`
  instead of `import.meta.env.VITE_OIDC_*`. It already runs post-bootstrap (at
  `AuthProvider` mount), so there is no timing change. `oidcRedirectUri` keeps
  its `?? \`${origin}/callback\`` fallback.
- All `import.meta.env.VITE_API_URL` / `VITE_OIDC_*` reads are removed. The
  `import.meta.env.DEV` styleguide-route gate stays — that is a genuine
  build-time concern, not runtime config.

### 4. The config file itself

- Commit **`apps/frontend/public/config.json`** containing the dev defaults.
  Vite serves it during `pnpm dev` and copies it into `dist/`, so the built
  image ships a working default at `/usr/share/nginx/html/config.json`.
- **Production**: the operator mounts their own `config.json` over that path
  (the chosen approach). If they forget to mount, the SPA falls back to the
  baked dev defaults (localhost issuer) — a visible auth failure, documented as
  "you must mount config.json in production".

### 5. Docker / infra changes

- **`apps/frontend/nginx.conf`**: add
  `location = /config.json { add_header Cache-Control "no-cache"; }` so a
  re-mounted or updated config is picked up on the next load (same treatment as
  `index.html`).
- **`apps/frontend/Dockerfile`**: remove the now-dead `VITE_API_URL` /
  `VITE_OIDC_*` build `ARG`/`ENV` block; update the header comment (no longer
  "inlined at build time"). The build no longer needs config values.
- **`docker-compose.build.yml`**: remove the frontend `args:` block.
- **`docker-compose.prod.yml`**: add a read-only volume mount to the `frontend`
  service:
  `- ./frontend-config.json:/usr/share/nginx/html/config.json:ro`.
- Add a committed **`frontend-config.json.example`** at the repo root with
  documented placeholders. Note the tradeoff: with a static file the OIDC issuer
  no longer auto-derives from `${AUTH_DOMAIN}`; the example documents setting it
  to match the deployment's `AUTH_DOMAIN`.
- Update **`apps/frontend/.env.example`** and **`docs/deployment.md`** to
  describe the `config.json` mount instead of frontend build args.

### 6. Testing

- **`src/config.test.ts`** (new): mock `fetch` and assert
  - a full 2xx JSON response is merged over defaults,
  - a partial JSON response merges per-key (missing keys keep defaults),
  - a 404 / network rejection / invalid JSON all fall back to `DEFAULT_CONFIG`,
  - `getConfig()` returns `DEFAULT_CONFIG` before `loadConfig()` runs.
- Light assertions that `getApiBase()` (via `client.ts`) and
  `createUserManager()` reflect a `setConfig(...)` override.

Tests use the existing vitest + jsdom setup; `fetch` is mocked as elsewhere in
the frontend suite.

## Data flow

```
container start → nginx serves mounted (or baked) config.json
browser loads index.html → main.tsx: await loadConfig() → setConfig(singleton)
                         → render → client.ts / user-manager.ts read getConfig()
```

## Files touched

New:
- `apps/frontend/src/config.ts`
- `apps/frontend/src/config.test.ts`
- `apps/frontend/public/config.json`
- `frontend-config.json.example` (repo root)

Modified:
- `apps/frontend/src/main.tsx`
- `apps/frontend/src/api/client.ts`
- `apps/frontend/src/auth/user-manager.ts`
- `apps/frontend/nginx.conf`
- `apps/frontend/Dockerfile`
- `apps/frontend/.env.example`
- `docker-compose.build.yml`
- `docker-compose.prod.yml`
- `docs/deployment.md`
