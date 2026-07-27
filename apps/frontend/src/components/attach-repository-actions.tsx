/**
 * How a repository gets attached, offered as two branches (GP-231).
 *
 * Ordering is the message. **Import** is the primary action wherever an
 * installation can list repositories: attaching should be an act of selection.
 * **Attach by URL** stays beside it as the secondary path, for the cases the
 * first cannot reach — a self-hosted host, a provider with no app, a repository
 * outside the installation's scope.
 *
 * Which branch exists is read from the registry, never assumed: the import
 * button appears only when this org holds a connection whose provider actually
 * declares `repo:discover`, so a deployment with no GitHub App shows exactly
 * one road and it is one that works.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Download, Plus } from "lucide-react";

import { listConnections, listProviderCatalog } from "@/api/client";
import type { CreatedRepository } from "@/api/types";
import { AttachRepositoryDialog } from "@/components/attach-repository-dialog";
import { Button } from "@/components/ui/button";

export function AttachRepositoryActions({
  projectId,
  onAttached,
  size = "sm",
  firstRepository = false,
}: Readonly<{
  projectId: string;
  onAttached: (repo: CreatedRepository) => void;
  size?: "sm" | "default";
  /** Wording for the empty state, where this is someone's very first repo. */
  firstRepository?: boolean;
}>) {
  const [canImport, setCanImport] = useState(false);

  useEffect(() => {
    Promise.all([listConnections(), listProviderCatalog()])
      .then(([connections, catalog]) => {
        const discovers = new Set(
          catalog
            .filter((provider) => provider.capabilities.includes("repo:discover"))
            .map((provider) => provider.id),
        );
        setCanImport(connections.some((c) => discovers.has(c.provider)));
      })
      // No connection, or a backend that cannot say: the URL path still works.
      .catch(() => setCanImport(false));
  }, []);

  return (
    <div className="flex items-center gap-2">
      {canImport && (
        <Button size={size} asChild>
          <Link to={`/import?project=${encodeURIComponent(projectId)}`}>
            <Download className="size-4" />
            Import from GitHub
          </Link>
        </Button>
      )}
      <AttachRepositoryDialog
        projectId={projectId}
        onAttached={onAttached}
        trigger={
          <Button size={size} variant={canImport ? "outline" : "default"}>
            <Plus className="size-4" />
            {canImport
              ? "Attach by URL"
              : firstRepository
                ? "Attach your first repository"
                : "Attach repository"}
          </Button>
        }
      />
    </div>
  );
}
