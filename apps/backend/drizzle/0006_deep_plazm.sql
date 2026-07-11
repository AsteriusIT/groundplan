CREATE TYPE "public"."graph_snapshot_source" AS ENUM('plan', 'hcl');--> statement-breakpoint
CREATE TABLE "graph_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"source" "graph_snapshot_source" NOT NULL,
	"ref" text NOT NULL,
	"commit_sha" text NOT NULL,
	"pr_number" integer,
	"graph" jsonb NOT NULL,
	"stats" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD CONSTRAINT "graph_snapshots_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;