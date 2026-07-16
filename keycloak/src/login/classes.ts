import type { ClassKey } from "keycloakify/login/lib/kcClsx";

/*
 * A Keycloakify `classes` map: for every login page we DON'T hand-override
 * (register, reset-password, OTP, verify-email, update-password, error, info, …)
 * Keycloakify renders its default markup, tagging each element with a semantic
 * class key (`kcInputClass`, `kcButtonPrimaryClass`, …). Because we build with
 * `doUseDefaultCss: false`, no PatternFly styling is loaded — so we map those
 * keys to the same carbon Tailwind utilities our shadcn primitives use. The
 * result: every page inherits the carbon look for free, and the hand-built
 * `Login` page (which uses the shadcn components directly) stays pixel-consistent
 * with them.
 *
 * These strings are plain source, so Tailwind's scanner picks the utilities up.
 */

const input =
  "h-9 w-full min-w-0 rounded-md border border-input bg-input/30 px-3 py-1 text-sm text-foreground shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/40";

const label = "mb-1.5 block text-sm font-medium text-foreground";

const buttonBase =
  "inline-flex h-10 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md px-5 text-sm font-medium transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50";

/**
 * Keys are typed against Keycloakify's `ClassKey`, so a renamed/removed key is a
 * compile error rather than a silent no-op.
 */
export const classes: Partial<Record<ClassKey, string>> = {
  // — form controls —
  kcInputClass: input,
  kcTextareaClass: input,
  kcLabelClass: label,
  kcFormGroupClass: "mb-4 flex flex-col",
  kcFormGroupErrorClass: "",
  kcInputWrapperClass: "",
  kcLabelWrapperClass: "",
  kcInputErrorMessageClass: "mt-1.5 block text-sm text-delete",
  kcInputHelperTextBeforeClass: "mt-1.5 block text-sm text-muted-foreground",
  kcInputHelperTextAfterClass: "mt-1.5 block text-sm text-muted-foreground",

  // — buttons —
  kcButtonClass: buttonBase,
  kcButtonPrimaryClass:
    "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
  kcButtonSecondaryClass:
    "border border-input bg-input/30 text-foreground shadow-xs hover:bg-input/50",
  kcButtonDefaultClass:
    "border border-input bg-input/30 text-foreground shadow-xs hover:bg-input/50",
  kcButtonBlockClass: "w-full",
  kcButtonLargeClass: "",

  // — options row (remember-me / forgot-password) —
  kcFormOptionsClass: "text-sm",
  kcFormOptionsWrapperClass: "text-sm",
  kcFormSettingClass: "mb-4 flex items-center justify-between gap-4",
  kcFormButtonsClass: "mt-2 flex flex-col gap-2",
  kcFormButtonsWrapperClass: "flex flex-col gap-2",

  // — password visibility group —
  kcInputGroup: "flex items-stretch gap-2",
  kcFormPasswordVisibilityButtonClass:
    "inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md border border-input bg-input/30 text-muted-foreground transition-colors hover:bg-input/50 hover:text-foreground",

  // — alerts (Template renders its own; this covers in-body alerts) —
  kcAlertClass:
    "relative mb-4 w-full rounded-md border border-border bg-accent-soft px-4 py-3 text-sm text-foreground",
  kcAlertTitleClass: "font-medium",

  // — social providers —
  kcFormSocialAccountSectionClass: "mt-6",
  kcFormSocialAccountListClass: "flex flex-col gap-2",
  kcFormSocialAccountListGridClass: "grid grid-cols-2 gap-2",
  kcFormSocialAccountListButtonClass: `${buttonBase} w-full border border-input bg-input/30 text-foreground hover:bg-input/50`,
  kcFormSocialAccountNameClass: "truncate",

  // — "select authenticator" / OTP list (try-another-way, OTP) —
  kcSelectAuthListClass: "flex flex-col gap-2",
  kcSelectAuthListItemClass:
    "flex items-center gap-3 rounded-md border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-accent/50",
  kcSelectAuthListItemHeadingClass: "text-sm font-medium text-foreground",
  kcSelectAuthListItemDescriptionClass: "text-sm text-muted-foreground",
  kcSelectAuthListItemBodyClass: "flex-1",
  kcSelectAuthListItemFillClass: "flex-1",
  kcSelectAuthListItemArrowClass: "text-muted-foreground",

  // — OTP entry list —
  kcLoginOTPListClass:
    "flex items-center gap-3 rounded-md border border-border bg-card px-4 py-3",
  kcLoginOTPListItemTitleClass: "text-sm font-medium text-foreground",

  // — misc structural —
  kcContentWrapperClass: "",
  kcFormClass: "",
  kcFormAreaClass: "",
  kcSignUpClass: "mt-6 text-center text-sm text-muted-foreground",
  kcResetFlowIcon: "hidden",
};
