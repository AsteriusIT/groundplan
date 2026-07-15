CREATE TABLE "remote_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"ref_name" text NOT NULL,
	"sha" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remote_refs_repo_ref_unique" UNIQUE("repository_id","ref_name")
);
--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "last_polled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "poll_error" text;--> statement-breakpoint
ALTER TABLE "remote_refs" ADD CONSTRAINT "remote_refs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;