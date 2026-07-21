CREATE TYPE "public"."integration_type" AS ENUM('atlassian');--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" "integration_type" NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"credential" text NOT NULL,
	"connection_status" "confluence_connection_status" DEFAULT 'unverified' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- GP-183 data migration: the Confluence credential moves off each repository and
-- onto an org-level Integration. Add the column nullable, lift every existing
-- per-repo connection into one Integration in the repo's org (carrying its base
-- URL, auth, credential and verify state), point the connection at it, then
-- enforce NOT NULL + the FK. On a fresh database this is inert (no connections
-- to lift). No cross-repo dedup: the credential is AES-GCM ciphertext (a random
-- IV per row), so distinct ciphertexts cannot be compared in SQL — one
-- Integration per existing connection is the safe migration; sharing is what the
-- new model *enables*, not something the backfill must retrofit.
ALTER TABLE "confluence_connections" ADD COLUMN "integration_id" uuid;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "migrated_connection_id" uuid;--> statement-breakpoint
INSERT INTO "integrations" ("organization_id", "type", "name", "config", "credential", "connection_status", "verified_at", "migrated_connection_id")
	SELECT "p"."organization_id", 'atlassian', "cc"."base_url",
		jsonb_build_object('baseUrl', "cc"."base_url", 'authType', "cc"."auth_type"::text, 'email', "cc"."email"),
		"cc"."credential", "cc"."connection_status", "cc"."verified_at", "cc"."id"
	FROM "confluence_connections" "cc"
	JOIN "repositories" "r" ON "r"."id" = "cc"."repository_id"
	JOIN "projects" "p" ON "p"."id" = "r"."project_id";--> statement-breakpoint
UPDATE "confluence_connections" "cc" SET "integration_id" = "i"."id"
	FROM "integrations" "i" WHERE "i"."migrated_connection_id" = "cc"."id";--> statement-breakpoint
ALTER TABLE "integrations" DROP COLUMN "migrated_connection_id";--> statement-breakpoint
ALTER TABLE "confluence_connections" ALTER COLUMN "integration_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "confluence_connections" ADD CONSTRAINT "confluence_connections_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confluence_connections" DROP COLUMN "base_url";--> statement-breakpoint
ALTER TABLE "confluence_connections" DROP COLUMN "auth_type";--> statement-breakpoint
ALTER TABLE "confluence_connections" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "confluence_connections" DROP COLUMN "credential";--> statement-breakpoint
ALTER TABLE "confluence_connections" DROP COLUMN "connection_status";--> statement-breakpoint
ALTER TABLE "confluence_connections" DROP COLUMN "verified_at";
