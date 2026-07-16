import { useEffect } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Info as InfoIcon,
  LogOut,
  TriangleAlert,
} from "lucide-react";

import type { TemplateProps } from "keycloakify/account/TemplateProps";
import { useInitialize } from "keycloakify/account/Template.useInitialize";
import { kcSanitize } from "keycloakify/lib/kcSanitize";

import type { I18n } from "./i18n";
import type { KcContext } from "./KcContext";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// Carbon shell for the account console (Multi-Page): top bar with the wordmark +
// sign-out, a sidebar of the account sections (highlighting `active`), and the
// page content in a card. The account pages themselves render bootstrap markup,
// which the `.gp-account …` rules in index.css carbon-style.
export default function Template(
  props: Readonly<TemplateProps<KcContext, I18n>>,
) {
  const { kcContext, i18n, doUseDefaultCss, active, children } = props;

  const { msg, msgStr, currentLanguage, enabledLanguages } = i18n;
  const { url, features, realm, message, referrer } = kcContext;

  useEffect(() => {
    document.title = msgStr("accountManagementTitle");
  }, [msgStr]);

  const { isReadyToRender } = useInitialize({ kcContext, doUseDefaultCss });
  if (!isReadyToRender) {
    return null;
  }

  const navItems: { key: string; href: string; label: React.ReactNode }[] = [
    { key: "account", href: url.accountUrl, label: msg("account") },
    ...(features.passwordUpdateSupported
      ? [{ key: "password", href: url.passwordUrl, label: msg("password") }]
      : []),
    { key: "totp", href: url.totpUrl, label: msg("authenticator") },
    ...(features.identityFederation
      ? [{ key: "social", href: url.socialUrl, label: msg("federatedIdentity") }]
      : []),
    { key: "sessions", href: url.sessionsUrl, label: msg("sessions") },
    {
      key: "applications",
      href: url.applicationsUrl,
      label: msg("applications"),
    },
    ...(features.log
      ? [{ key: "log", href: url.logUrl, label: msg("log") }]
      : []),
    ...(realm.userManagedAccessAllowed && features.authorization
      ? [{ key: "authorization", href: url.resourceUrl, label: msg("myResources") }]
      : []),
  ];

  return (
    <div className="carbon-grid min-h-svh">
      <header className="border-b border-border bg-card/60 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-3">
          <span className="font-display text-lg font-semibold tracking-tight text-foreground">
            groundplan
          </span>
          <div className="flex items-center gap-4 text-sm">
            {enabledLanguages.length > 1 && (
              <select
                aria-label="Language"
                className="h-8 rounded-md border border-input bg-input/30 px-2 text-sm text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                value={currentLanguage.languageTag}
                onChange={(event) => {
                  const next = enabledLanguages.find(
                    (language) => language.languageTag === event.target.value,
                  );
                  if (next) window.location.href = next.href;
                }}
              >
                {enabledLanguages.map(({ languageTag, label }) => (
                  <option key={languageTag} value={languageTag}>
                    {label}
                  </option>
                ))}
              </select>
            )}
            {referrer?.url && (
              <a
                href={referrer.url}
                id="referrer"
                className="text-primary hover:underline"
              >
                {msg("backTo", referrer.name ?? "")}
              </a>
            )}
            <a
              href={url.getLogoutUrl()}
              className="inline-flex items-center gap-1.5 rounded-md border border-input bg-input/30 px-3 py-1.5 text-foreground transition-colors hover:bg-input/50"
            >
              <LogOut className="size-3.5" aria-hidden />
              {msg("doSignOut")}
            </a>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-8 sm:flex-row">
        <aside className="shrink-0 sm:w-56">
          <nav className="flex gap-1 overflow-x-auto sm:flex-col">
            {navItems.map((item) => (
              <a
                key={item.key}
                href={item.href}
                aria-current={active === item.key ? "page" : undefined}
                className={cn(
                  "rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors",
                  active === item.key
                    ? "bg-accent-soft font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                {item.label}
              </a>
            ))}
          </nav>
        </aside>

        <main className="min-w-0 flex-1">
          {message !== undefined && (
            <Alert
              variant={message.type}
              id="account-message"
              className="mb-6"
            >
              <MessageIcon type={message.type} />
              <AlertDescription>
                <span
                  className="text-foreground"
                  dangerouslySetInnerHTML={{
                    __html: kcSanitize(message.summary),
                  }}
                />
              </AlertDescription>
            </Alert>
          )}
          <Card className="gp-account gap-0 p-6 sm:p-7">{children}</Card>
        </main>
      </div>
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
