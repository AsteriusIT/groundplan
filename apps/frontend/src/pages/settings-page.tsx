import { useEffect } from "react";

import { useOrg } from "@/org/use-org";
import { useCan } from "@/rbac/use-can";
import { PageHeader } from "@/components/page-header";
import {
  AccountCard,
  AiCard,
  AppearanceCard,
  DangerCard,
  IngestionCard,
  IntegrationsCard,
  InvitesCard,
  MembersCard,
  SettingsRail,
  SettingsSections,
  type SectionGroup,
} from "@/components/settings-sections";

/**
 * Settings: identity, org management (GP-118), display preferences, the
 * app-wide CI token and the AI readout. A sticky rail mirrors the sections —
 * both render from the same `groups` value, so the nav can never drift from
 * the page.
 */
export function SettingsPage() {
  const { activeOrg, singleOrg } = useOrg();
  const canManage = useCan("member:manage");
  const canDelete = useCan("org:delete");
  const showInvites = !singleOrg && canManage;
  const showDanger = !singleOrg && canDelete && activeOrg !== null;

  // A hash on arrival scrolls to its section (jsdom's scrollIntoView is a
  // test-setup no-op). A hash for a hidden section simply finds no element.
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash) document.getElementById(hash)?.scrollIntoView();
  }, []);

  const groups: SectionGroup[] = [
    {
      label: "Personal",
      sections: [
        { id: "account", label: "Account", element: <AccountCard /> },
        { id: "appearance", label: "Appearance", element: <AppearanceCard /> },
      ],
    },
    {
      label: "Organization",
      sections: [
        { id: "members", label: "Members", element: <MembersCard /> },
        {
          id: "integrations",
          label: "Integrations",
          element: <IntegrationsCard />,
        },
        ...(showInvites
          ? [
              {
                id: "invitations",
                label: "Invitations",
                element: <InvitesCard />,
              },
            ]
          : []),
      ],
    },
    {
      label: "Workspace",
      sections: [
        {
          id: "ci-token",
          label: "CI ingestion token",
          element: <IngestionCard />,
        },
        { id: "ai", label: "AI", element: <AiCard /> },
      ],
    },
    ...(showDanger
      ? [
          {
            label: null,
            sections: [
              { id: "danger", label: "Danger zone", element: <DangerCard /> },
            ],
          },
        ]
      : []),
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Account"
        title="Settings"
        description="Your identity, the look of the canvas, and what the server has enabled."
      />
      <div className="mx-auto flex max-w-5xl items-start gap-10 px-8 py-8">
        <SettingsRail groups={groups} />
        <SettingsSections groups={groups} />
      </div>
    </div>
  );
}
