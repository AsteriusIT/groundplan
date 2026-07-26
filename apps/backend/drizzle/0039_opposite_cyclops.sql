CREATE TABLE "policy_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"repository_id" uuid,
	"report" jsonb NOT NULL,
	"summary_md" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_reports_snapshot_unique" UNIQUE("snapshot_id")
);
--> statement-breakpoint
ALTER TABLE "policy_reports" ADD CONSTRAINT "policy_reports_snapshot_id_graph_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."graph_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_reports" ADD CONSTRAINT "policy_reports_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;