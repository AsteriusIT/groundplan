---
title: OIDC & single sign-on
description: Connect any OIDC identity provider — what the SPA needs, what the API checks, and the three ways it usually goes wrong.
---

For whoever owns identity in your organization. %PRODUCT% has no user database,
no password reset and no login page of its own: it is an OIDC **resource
server**, and your identity provider is the only thing that authenticates
anybody. Any compliant provider works — Entra ID, Okta, Auth0, Keycloak, Google
Workspace, Authentik.

The bundled Keycloak in the compose file is an included convenience, not a
dependency, and this page deliberately describes the third-party case.

## What has to be true

Two objects and three claims.

<div class="sl-markdown-content">

**1. A public client for the browser.** The frontend is a single-page app: it
authenticates with **Authorization Code + PKCE** and holds no client secret,
because anything shipped to a browser is not a secret.

| Setting | Value |
| --- | --- |
| Client type | Public / SPA (no secret) |
| Grant | Authorization code with PKCE |
| Redirect URI | `https://<your host>/callback` |
| Post-logout redirect | `https://<your host>/` |
| Web origin / CORS | `https://<your host>` |
| Scopes | `openid`, `profile`, `email` |

**2. An audience the API can check.** The access token that reaches the API must
carry `aud` containing the value of `OIDC_AUDIENCE` (`groundplan-api` by
default). Providers differ on how you say this:

| Provider | How the audience is set |
| --- | --- |
| Keycloak | An **audience mapper** on the client, or a client scope adding it |
| Entra ID | Expose an API on an app registration; the SPA requests that scope, and `aud` becomes the API's application id URI — set `OIDC_AUDIENCE` to that |
| Auth0 | The **API identifier** you created; the SPA passes it as `audience` |
| Okta | The authorization server's audience setting |

</div>

**3. A stable subject.** The `sub` claim identifies a user for the life of the
deployment. `email` and `name` are read when present and are only used for
display — a user row is created the first time somebody presents a valid token,
so there is no invite-before-login step and no user provisioning to run.

## Configure it

```ini
OIDC_ISSUER_URL=https://login.example.com/realms/platform
OIDC_AUDIENCE=groundplan-api
```

```json title="frontend-config.json"
{
  "apiUrl": "",
  "oidcIssuer": "https://login.example.com/realms/platform",
  "oidcClientId": "groundplan-frontend"
}
```

The issuer must be **byte-identical** in both places and identical to the `iss`
claim in the tokens — including the presence or absence of a trailing slash.
Discovery documents are fetched from `${OIDC_ISSUER_URL}/.well-known/…`, so the
API must be able to reach the provider over the network, and it must reach it on
the same URL the browser uses. Behind a single public IP, that means DNS
hairpinning has to work.

On Kubernetes the same three values are `oidc.issuerUrl`, `oidc.audience` and
`oidc.clientId` — see [Helm values](/install/helm-values/).

## Roles are not claims

%PRODUCT% does not read groups or roles from your token. Authorization is its
own: a user's role inside an organization (`owner` / `admin` / `member`) is set
in the product, not by your provider. Your provider decides **who may log in**;
the organization decides **what they may change**. There is no claim mapping to
configure and no group-to-role sync — see
[Organizations & roles](/admin/organizations/).

In `SINGLE_ORG` mode this means anybody your provider lets in joins the
organization as a `member` and can read the whole estate. If that is not what
you want, restrict at the provider — the client's assignment policy is the right
lever, and it is the one your security team already audits.

## The three failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every API call is `401`, login itself worked | The token's `aud` does not contain `OIDC_AUDIENCE`. Decode the token and look. | Add the audience mapper / request the API scope. |
| Redirect loop between the app and the provider | Redirect URI not registered exactly, or the issuer in `frontend-config.json` differs from `OIDC_ISSUER_URL`. | Make both strings identical, including the trailing slash. |
| `401` with a valid-looking token | Clock skew, or a signature the API cannot verify because discovery failed. | Check NTP on both hosts; check the API can reach the issuer URL. |

The API refuses to boot in production with no issuer configured, so a
misconfiguration is loud rather than silent — [Troubleshooting](/help/troubleshooting/)
has the exact messages.
