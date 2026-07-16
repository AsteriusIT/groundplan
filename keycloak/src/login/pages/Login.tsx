import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import type { PageProps } from "keycloakify/login/pages/PageProps";
import { useIsPasswordRevealed } from "keycloakify/tools/useIsPasswordRevealed";
import { kcSanitize } from "keycloakify/lib/kcSanitize";

import type { KcContext } from "../KcContext";
import type { I18n } from "../i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// Hand-built carbon login page (replaces Keycloakify's default). The form
// semantics — field names, `action`/`method`, `aria-invalid`, the hidden
// credentialId, remember-me — match the default exactly so Keycloak's auth flow
// is unchanged; only the presentation uses the shadcn primitives.
export default function Login(
  props: Readonly<PageProps<Extract<KcContext, { pageId: "login.ftl" }>, I18n>>,
) {
  const { kcContext, i18n, doUseDefaultCss, Template, classes } = props;

  const {
    social,
    realm,
    url,
    usernameHidden,
    login,
    auth,
    registrationDisabled,
    messagesPerField,
    enableWebAuthnConditionalUI,
  } = kcContext;

  const { msg, msgStr } = i18n;

  const [isLoginButtonDisabled, setIsLoginButtonDisabled] = useState(false);

  const hasError = messagesPerField.existsError("username", "password");

  const usernameLabel = !realm.loginWithEmailAllowed
    ? msg("username")
    : !realm.registrationEmailAsUsername
      ? msg("usernameOrEmail")
      : msg("email");

  return (
    <Template
      kcContext={kcContext}
      i18n={i18n}
      doUseDefaultCss={doUseDefaultCss}
      classes={classes}
      displayMessage={!hasError}
      headerNode={msg("loginAccountTitle")}
      displayInfo={
        realm.password && realm.registrationAllowed && !registrationDisabled
      }
      infoNode={
        <div id="kc-registration-container">
          <div id="kc-registration">
            <span>
              {msg("noAccount")}{" "}
              <a
                tabIndex={8}
                href={url.registrationUrl}
                className="font-medium text-primary hover:underline"
              >
                {msg("doRegister")}
              </a>
            </span>
          </div>
        </div>
      }
      socialProvidersNode={
        realm.password &&
        social?.providers !== undefined &&
        social.providers.length !== 0 ? (
          <div id="kc-social-providers" className="mt-2 flex flex-col gap-3">
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              {msg("identity-provider-login-label")}
              <span className="h-px flex-1 bg-border" />
            </div>
            <ul
              className={cn(
                "flex flex-col gap-2",
                social.providers.length > 3 && "grid grid-cols-2",
              )}
            >
              {social.providers.map((p) => (
                <li key={p.alias}>
                  <a
                    id={`social-${p.alias}`}
                    href={p.loginUrl}
                    className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-input bg-input/30 px-4 text-sm font-medium text-foreground transition-colors hover:bg-input/50"
                  >
                    <span
                      dangerouslySetInnerHTML={{
                        __html: kcSanitize(p.displayName),
                      }}
                    />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null
      }
    >
      {realm.password && (
        <form
          id="kc-form-login"
          onSubmit={() => {
            setIsLoginButtonDisabled(true);
            return true;
          }}
          action={url.loginAction}
          method="post"
          className="flex flex-col gap-4"
        >
          {!usernameHidden && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="username">{usernameLabel}</Label>
              <Input
                tabIndex={2}
                id="username"
                name="username"
                defaultValue={login.username ?? ""}
                type="text"
                autoFocus
                autoComplete={
                  enableWebAuthnConditionalUI ? "username webauthn" : "username"
                }
                aria-invalid={hasError}
              />
              {hasError && (
                <span
                  id="input-error"
                  aria-live="polite"
                  className="text-sm text-delete"
                  dangerouslySetInnerHTML={{
                    __html: kcSanitize(
                      messagesPerField.getFirstError("username", "password"),
                    ),
                  }}
                />
              )}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="password">{msg("password")}</Label>
              {realm.resetPasswordAllowed && (
                <a
                  tabIndex={6}
                  href={url.loginResetCredentialsUrl}
                  className="text-sm text-primary hover:underline"
                >
                  {msg("doForgotPassword")}
                </a>
              )}
            </div>
            <PasswordInput
              id="password"
              name="password"
              i18n={i18n}
              ariaInvalid={hasError}
            />
            {usernameHidden && hasError && (
              <span
                id="input-error"
                aria-live="polite"
                className="text-sm text-delete"
                dangerouslySetInnerHTML={{
                  __html: kcSanitize(
                    messagesPerField.getFirstError("username", "password"),
                  ),
                }}
              />
            )}
          </div>

          {realm.rememberMe && !usernameHidden && (
            <label
              htmlFor="rememberMe"
              className="flex items-center gap-2 text-sm text-muted-foreground select-none"
            >
              <input
                tabIndex={5}
                id="rememberMe"
                name="rememberMe"
                type="checkbox"
                defaultChecked={!!login.rememberMe}
                className="size-4 accent-primary"
              />
              {msg("rememberMe")}
            </label>
          )}

          <input
            type="hidden"
            id="id-hidden-input"
            name="credentialId"
            defaultValue={auth.selectedCredential}
          />

          <Button
            tabIndex={7}
            type="submit"
            name="login"
            id="kc-login"
            disabled={isLoginButtonDisabled}
            className="h-10 w-full"
          >
            {msgStr("doLogIn")}
          </Button>
        </form>
      )}
    </Template>
  );
}

function PasswordInput(
  props: Readonly<{
    id: string;
    name: string;
    i18n: I18n;
    ariaInvalid: boolean;
  }>,
) {
  const { id, name, i18n, ariaInvalid } = props;
  const { msgStr } = i18n;
  // The hook owns the input's `type` attribute (toggles the DOM node directly),
  // so the JSX keeps `type="password"` and we use the state only for the icon.
  const { isPasswordRevealed, toggleIsPasswordRevealed } = useIsPasswordRevealed(
    { passwordInputId: id },
  );

  return (
    <div className="flex items-stretch gap-2">
      <Input
        tabIndex={3}
        id={id}
        name={name}
        type="password"
        autoComplete="current-password"
        aria-invalid={ariaInvalid}
        className="flex-1"
      />
      <button
        type="button"
        aria-label={msgStr(isPasswordRevealed ? "hidePassword" : "showPassword")}
        aria-controls={id}
        onClick={toggleIsPasswordRevealed}
        className="inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md border border-input bg-input/30 text-muted-foreground transition-colors hover:bg-input/50 hover:text-foreground"
      >
        {isPasswordRevealed ? (
          <EyeOff className="size-4" aria-hidden />
        ) : (
          <Eye className="size-4" aria-hidden />
        )}
      </button>
    </div>
  );
}
