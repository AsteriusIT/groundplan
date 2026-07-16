import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { KcPage } from "./kc.gen";

// Local dev preview. `pnpm dev` serves a mock Keycloak page so we can iterate on
// the theme without a running Keycloak. Pick a page with the `?page=` query, e.g.
// `?page=register.ftl`, `?page=login-reset-password.ftl`, `?page=error.ftl`.
if (import.meta.env.DEV && !window.kcContext) {
  const { getKcContextMock } = await import("./login/KcPageStory");
  const pageId =
    (new URLSearchParams(window.location.search).get("page") as
      | Parameters<typeof getKcContextMock>[0]["pageId"]
      | null) ?? "login.ftl";
  window.kcContext = getKcContextMock({
    pageId,
    overrides: {},
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {!window.kcContext ? (
      <h1>No Keycloak Context</h1>
    ) : (
      <KcPage kcContext={window.kcContext} />
    )}
  </StrictMode>,
);
