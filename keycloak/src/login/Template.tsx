import { useEffect } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Info as InfoIcon,
  TriangleAlert,
  RotateCcw,
} from "lucide-react";

import type { TemplateProps } from "keycloakify/login/TemplateProps";
import { useInitialize } from "keycloakify/login/Template.useInitialize";
import { kcSanitize } from "keycloakify/lib/kcSanitize";

import type { I18n } from "./i18n";
import type { KcContext } from "./KcContext";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// The carbon shell every login page renders inside: the groundplan wordmark, a
// centered card, sanitized Keycloak messages, the attempted-username banner, the
// "try another way" affordance and the language switcher. Restyled from
// Keycloakify's default Template — the Keycloak-integration behaviour (script
// loading via `useInitialize`, message sanitization, form actions) is preserved;
// only the presentation is ours.
export default function Template(
  props: Readonly<TemplateProps<KcContext, I18n>>,
) {
  const {
    displayInfo = false,
    displayMessage = true,
    displayRequiredFields = false,
    headerNode,
    socialProvidersNode = null,
    infoNode = null,
    documentTitle,
    bodyClassName,
    kcContext,
    i18n,
    doUseDefaultCss,
    children,
  } = props;

  const { msg, msgStr, currentLanguage, enabledLanguages } = i18n;

  const { realm, auth, url, message, isAppInitiatedAction } = kcContext;

  useEffect(() => {
    document.title =
      documentTitle ?? msgStr("loginTitle", realm.displayName || realm.name);
  }, [documentTitle, msgStr, realm.displayName, realm.name]);

  const { isReadyToRender } = useInitialize({ kcContext, doUseDefaultCss });

  if (!isReadyToRender) {
    return null;
  }

  const showAttemptedUsername =
    auth !== undefined && auth.showUsername && !auth.showResetCredentials;

  return (
    <div
      className={cn(
        "carbon-grid flex min-h-svh flex-col items-center justify-center px-4 py-10",
        bodyClassName,
      )}
    >
      <main className="w-full max-w-100">
        {/* Wordmark */}
        <div className="mb-6 flex flex-col items-center gap-1 text-center">
          <span className="font-display text-2xl font-semibold tracking-tight text-foreground">
            groundplan
          </span>
          <span className="text-sm text-muted-foreground">
            Terraform, as a living diagram
          </span>
        </div>

        <Card className="gap-0 rounded-xl border-border py-0 shadow-lg">
          <div className="flex flex-col gap-5 p-6 sm:p-7">
            {enabledLanguages.length > 1 && (
              <LanguageSwitcher
                enabledLanguages={enabledLanguages}
                currentLanguage={currentLanguage}
                ariaLabel={msgStr("languages")}
              />
            )}

            {/* Page title, or the attempted-username banner */}
            {showAttemptedUsername ? (
              <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-accent-soft px-3 py-2">
                <span className="truncate font-mono text-sm text-foreground">
                  {auth.attemptedUsername}
                </span>
                <a
                  href={url.loginRestartFlowUrl}
                  aria-label={msgStr("restartLoginTooltip")}
                  className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                  {msg("restartLoginTooltip")}
                </a>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <h1
                  id="kc-page-title"
                  className="font-display text-xl font-semibold tracking-tight text-foreground"
                >
                  {headerNode}
                </h1>
                {displayRequiredFields && (
                  <span className="text-sm text-muted-foreground">
                    <span className="text-delete">*</span>{" "}
                    {msg("requiredFields")}
                  </span>
                )}
              </div>
            )}

            {/* Keycloak message (sanitized) */}
            {displayMessage &&
              message !== undefined &&
              (message.type !== "warning" || !isAppInitiatedAction) && (
                <Alert variant={message.type} id="kc-message">
                  <MessageIcon type={message.type} />
                  <AlertDescription>
                    <span
                      className="text-foreground"
                      // Keycloak message summaries may contain markup; kcSanitize
                      // strips anything unsafe (same guarantee as the default theme).
                      dangerouslySetInnerHTML={{
                        __html: kcSanitize(message.summary),
                      }}
                    />
                  </AlertDescription>
                </Alert>
              )}

            {/* Page body */}
            <div id="kc-content">
              <div id="kc-content-wrapper">{children}</div>
            </div>

            {/* Try another way */}
            {auth !== undefined && auth.showTryAnotherWayLink && (
              <form
                id="kc-select-try-another-way-form"
                action={url.loginAction}
                method="post"
              >
                <input type="hidden" name="tryAnotherWay" value="on" />
                <button
                  type="submit"
                  id="try-another-way"
                  className="cursor-pointer text-sm text-primary hover:underline"
                >
                  {msg("doTryAnotherWay")}
                </button>
              </form>
            )}

            {socialProvidersNode}
          </div>

          {/* Info footer (e.g. "New user? Register") */}
          {displayInfo && (
            <div
              id="kc-info"
              className="border-t border-border px-6 py-4 text-center text-sm text-muted-foreground sm:px-7"
            >
              <div id="kc-info-wrapper">{infoNode}</div>
            </div>
          )}
        </Card>

        <p className="mt-6 text-center text-xs text-faint">
          Secured by Keycloak · groundplan
        </p>
      </main>
    </div>
  );
}

function MessageIcon({
  type,
}: Readonly<{ type: "success" | "warning" | "error" | "info" }>) {
  switch (type) {
    case "success":
      return <CheckCircle2 aria-hidden />;
    case "warning":
      return <TriangleAlert aria-hidden />;
    case "error":
      return <AlertCircle aria-hidden />;
    case "info":
      return <InfoIcon aria-hidden />;
  }
}

function LanguageSwitcher(
  props: Readonly<{
    enabledLanguages: { languageTag: string; label: string; href: string }[];
    currentLanguage: { languageTag: string; label: string };
    ariaLabel: string;
  }>,
) {
  const { enabledLanguages, currentLanguage, ariaLabel } = props;
  return (
    <div className="flex justify-end" id="kc-locale">
      <select
        aria-label={ariaLabel}
        className="h-8 rounded-md border border-input bg-input/30 px-2 text-sm text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        value={currentLanguage.languageTag}
        onChange={(event) => {
          const next = enabledLanguages.find(
            (language) => language.languageTag === event.target.value,
          );
          if (next) {
            window.location.href = next.href;
          }
        }}
      >
        {enabledLanguages.map(({ languageTag, label }) => (
          <option key={languageTag} value={languageTag}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}
