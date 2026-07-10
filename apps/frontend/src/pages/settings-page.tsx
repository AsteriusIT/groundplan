import { PageHeader } from "@/components/page-header";
import { Placeholder } from "@/components/placeholder";

export function SettingsPage() {
  return (
    <div>
      <PageHeader
        eyebrow="Account"
        title="Settings"
        description="Workspace and account preferences."
      />
      <div className="p-8">
        <Placeholder note="Settings arrive alongside team and workspace features." />
      </div>
    </div>
  );
}
