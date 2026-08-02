/**
 * The application's four modes (GP-242).
 *
 * Terraform Documentation, Playground, AI Studio and Kubernetes Clusters are
 * not five sibling links in one list: they are four different jobs, and a
 * person doing one of them is not halfway through another. They move out of the
 * sidebar into a switcher beside the logo — the org switcher's pattern, one
 * level up — and the sidebar becomes navigation *within* the active mode.
 *
 * The mode is derived from the URL rather than stored: a deep link into a pull
 * request is Documentation mode by construction, so refresh, back and a pasted
 * link all land in the right place with nothing to keep in sync.
 */
import type { ComponentType } from "react";
import {
  Boxes,
  FlaskConical,
  LayoutDashboard,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { KubernetesMark } from "@/components/kubernetes-mark";

export type AppModeId = "docs" | "playground" | "clusters" | "studio";

export type NavEntry = {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Small trailing tag (e.g. "Experimental") — accent, never a status hue. */
  tag?: string;
};

export type AppMode = {
  id: AppModeId;
  label: string;
  /** One line in the switcher: what this mode is for. */
  description: string;
  icon: ComponentType<{ className?: string }>;
  /** Where selecting the mode lands. */
  root: string;
  /**
   * The route prefixes that belong to this mode. Order matters only in that
   * `modeForPath` takes the first match; the sets are disjoint.
   */
  paths: readonly string[];
  /** The sidebar's contents while this mode is active. May be empty. */
  nav: readonly NavEntry[];
  tag?: string;
  /** Gated on the AI layer (GP-62's rule): absent entirely when AI is off. */
  requiresAi?: boolean;
};

/**
 * Documentation is the mode the product opens in and the one every unknown
 * route belongs to: dashboards, projects, their pull requests and the standard
 * they are graded against are all one job — reviewing what the code says.
 */
export const APP_MODES: readonly AppMode[] = [
  {
    id: "docs",
    label: "Terraform Documentation",
    description: "Review changes and read the documentation of main",
    icon: LayoutDashboard,
    root: "/dashboard",
    paths: ["/dashboard", "/projects", "/import", "/policies"],
    nav: [
      { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { to: "/projects", label: "Projects", icon: Boxes },
      { to: "/policies", label: "Policies", icon: ShieldCheck },
    ],
  },
  {
    id: "playground",
    label: "Playground",
    description: "Sketch infrastructure without touching a repository",
    icon: FlaskConical,
    root: "/playground",
    paths: ["/playground"],
    nav: [],
  },
  {
    id: "studio",
    label: "AI Studio",
    description: "Describe infrastructure and read back what it would be",
    icon: Sparkles,
    root: "/studio",
    paths: ["/studio"],
    nav: [],
    tag: "Experimental",
    requiresAi: true,
  },
  {
    id: "clusters",
    label: "Kubernetes Clusters",
    description: "Read a live cluster, namespace by namespace",
    icon: KubernetesMark,
    root: "/clusters",
    paths: ["/clusters"],
    nav: [],
  },
];

/** The modes this deployment offers. AI off ⇒ AI Studio does not exist. */
export function availableModes(aiEnabled: boolean): readonly AppMode[] {
  return APP_MODES.filter((mode) => !mode.requiresAi || aiEnabled);
}

/**
 * Which mode a path belongs to. Anything unclaimed — settings, an invitation,
 * an integration callback — is Documentation: it is where the product starts
 * and where an unrecognised link should land rather than nowhere.
 */
export function modeForPath(pathname: string): AppModeId {
  const match = APP_MODES.find((mode) =>
    mode.paths.some(
      (path) => pathname === path || pathname.startsWith(`${path}/`),
    ),
  );
  return match?.id ?? "docs";
}

export function appMode(id: AppModeId): AppMode {
  const mode = APP_MODES.find((m) => m.id === id);
  // Unreachable: the id type is closed over APP_MODES' contents.
  if (!mode) throw new Error(`unknown app mode: ${id}`);
  return mode;
}
