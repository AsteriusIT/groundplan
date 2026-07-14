ALTER TYPE "public"."graph_snapshot_source" ADD VALUE 'k8s_namespace';--> statement-breakpoint
ALTER TABLE "graph_snapshots" ALTER COLUMN "repository_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD COLUMN "cluster_id" uuid;--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD COLUMN "namespace" text;--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD CONSTRAINT "graph_snapshots_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD CONSTRAINT "graph_snapshots_owner_check" CHECK (("graph_snapshots"."repository_id" is not null) <> ("graph_snapshots"."cluster_id" is not null));