CREATE TYPE "public"."policy_waiver_action" AS ENUM('created', 'extended', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."policy_waiver_status" AS ENUM('active', 'orphaned');--> statement-breakpoint
CREATE TABLE "policy_waiver_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"waiver_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"action" "policy_waiver_action" NOT NULL,
	"reason" text,
	"expires_at" timestamp with time zone,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_waivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"rule_id" text NOT NULL,
	"address" text NOT NULL,
	"reason" text NOT NULL,
	"status" "policy_waiver_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "policy_waiver_events" ADD CONSTRAINT "policy_waiver_events_waiver_id_policy_waivers_id_fk" FOREIGN KEY ("waiver_id") REFERENCES "public"."policy_waivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_waiver_events" ADD CONSTRAINT "policy_waiver_events_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_waiver_events" ADD CONSTRAINT "policy_waiver_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_waivers" ADD CONSTRAINT "policy_waivers_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_waivers" ADD CONSTRAINT "policy_waivers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "policy_waivers_live_unique" ON "policy_waivers" USING btree ("repository_id","rule_id","address") WHERE "policy_waivers"."revoked_at" is null;