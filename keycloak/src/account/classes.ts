import type { ClassKey } from "keycloakify/account/lib/kcClsx";

/*
 * The Multi-Page account pages mostly use bootstrap class names (`form-control`,
 * `control-label`, `form-group`, the grid) — those are styled by a scoped CSS
 * block in index.css (`.gp-account …`). Only the action buttons go through
 * `kcClsx`, so this map carbon-styles them (and the handful of form keys that
 * newer pages do use). Same utilities as the login `classes` map.
 */

const input =
  "h-9 w-full min-w-0 rounded-md border border-input bg-input/30 px-3 py-1 text-sm text-foreground shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50";

const buttonBase =
  "inline-flex h-10 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md px-5 text-sm font-medium transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50";

export const classes: Partial<Record<ClassKey, string>> = {
  kcInputClass: input,
  kcLabelClass: "mb-1.5 block text-sm font-medium text-foreground",
  kcFormGroupClass: "mb-5",
  kcInputWrapperClass: "",
  kcInputErrorMessageClass: "mt-1.5 block text-sm text-delete",
  kcFormClass: "",
  kcContentWrapperClass: "",

  kcButtonClass: buttonBase,
  kcButtonPrimaryClass:
    "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
  kcButtonDefaultClass:
    "border border-input bg-input/30 text-foreground shadow-xs hover:bg-input/50",
  kcButtonLargeClass: "",
};
