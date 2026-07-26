CREATE TABLE "ref_event_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"branch" text NOT NULL,
	"sha" text NOT NULL,
	"source" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ref_event_deliveries_fact" UNIQUE("repository_id","kind","branch","sha")
);
--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "webhook_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ref_event_deliveries" ADD CONSTRAINT "ref_event_deliveries_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;