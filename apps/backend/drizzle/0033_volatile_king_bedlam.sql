CREATE TYPE "public"."confluence_auth_type" AS ENUM('cloud_token', 'dc_pat');--> statement-breakpoint
CREATE TYPE "public"."confluence_connection_status" AS ENUM('unverified', 'ok', 'failed');--> statement-breakpoint
CREATE TABLE "confluence_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"base_url" text NOT NULL,
	"space_key" text NOT NULL,
	"auth_type" "confluence_auth_type" NOT NULL,
	"email" text,
	"credential" text NOT NULL,
	"connection_status" "confluence_connection_status" DEFAULT 'unverified' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "confluence_connections_repository_id_unique" UNIQUE("repository_id")
);
--> statement-breakpoint
ALTER TABLE "confluence_connections" ADD CONSTRAINT "confluence_connections_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;