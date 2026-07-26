CREATE TABLE "drift_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"snapshot_id" uuid,
	"ref" text NOT NULL,
	"commit_sha" text NOT NULL,
	"report" jsonb NOT NULL,
	"summary_md" text DEFAULT '' NOT NULL,
	"measured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drift_reports_repository_commit_unique" UNIQUE("repository_id","commit_sha")
);
--> statement-breakpoint
ALTER TABLE "drift_reports" ADD CONSTRAINT "drift_reports_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drift_reports" ADD CONSTRAINT "drift_reports_snapshot_id_graph_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."graph_snapshots"("id") ON DELETE set null ON UPDATE no action;