import { useEffect } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import { useOrg } from "@/org/use-org";
import { useCan } from "@/rbac/use-can";
import { PageHeader } from "@/components/page-header";
import {
  AiCard,
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
 * Organization settings (GP-188): the org-scoped sections split out of the old
 * combined page — Members, Integrations, Invitations, the app-wide CI token,
 * the AI readout and the danger zone. Lives at `/orgs/:orgId/settings`.
 *
 * The active org (context, localStorage-backed) is the single source of truth
 * for org-scoped data; the URL's `:orgId` reflects it. Switching orgs in the
 * sidebar remounts this page (the shell keys its outlet on the active org) with
 * a now-stale `:orgId`, and a deep link or old bookmark may point at a
 * different org — in both cases we bring the URL back in step with the org we
 * are actually in, which is where the sections already read and write.
 *
 * Every section is a component reused from the personal page (GP-187); each one
 * gates its own actions on the permission matrix (`useCan`), so a member sees
 * the roster and a read-only integration list but no admin controls. Invites
 * and the danger zone are page-gated the same way the old page gated them.
 */
export function OrgSettingsPage() {
  const { orgId } = useParams();
  const { activeOrg, singleOrg } = useOrg();
  const canManage = useCan("member:manage");
  const canDelete = useCan("org:delete");
  const navigate = useNavigate();
  const { hash } = useLocation();

  const showInvites = !singleOrg && canManage;
  const showDanger = !singleOrg && canDelete && activeOrg !== null;

  // Keep the URL's org in step with the active org (see the note above).
  useEffect(() => {
    if (activeOrg && orgId !== activeOrg.id) {
      navigate(`/orgs/${activeOrg.id}/settings${hash}`, { replace: true });
    }
  }, [activeOrg, orgId, hash, navigate]);

  // A hash on arrival (e.g. a legacy redirect landing on #members) scrolls to
  // its section (jsdom's scrollIntoView is a test-setup no-op).
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView();
  }, []);

  const groups: SectionGroup[] = [
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
        eyebrow="Organization"
        title="Organization settings"
        description={
          activeOrg
            ? `Members, integrations and workspace controls for ${activeOrg.name}.`
            : "Members, integrations and workspace controls."
        }
      />
      <div className="mx-auto flex max-w-5xl items-start gap-10 px-8 py-8">
        <SettingsRail groups={groups} />
        <SettingsSections groups={groups} />
      </div>
    </div>
  );
}
