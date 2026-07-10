import { PageHeader } from "@/components/page-header";
import { Placeholder } from "@/components/placeholder";

export function DashboardPage() {
  return (
    <div>
      <PageHeader
        eyebrow="Overview"
        title="Dashboard"
        description="A read on your estate at a glance."
      />
      <div className="p-8">
        <Placeholder note="The dashboard lands with the first analytics views." />
      </div>
    </div>
  );
}
