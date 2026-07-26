CREATE TYPE "public"."credential_mode" AS ENUM('pat', 'oauth2', 'installation_app');--> statement-breakpoint
CREATE TYPE "public"."credential_status" AS ENUM('unverified', 'ok', 'reconnect_required');--> statement-breakpoint
CREATE TABLE "integration_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" "repository_provider" NOT NULL,
	"mode" "credential_mode" NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret" text,
	"status" "credential_status" DEFAULT 'unverified' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "credential_id" uuid;--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_credential_id_integration_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."integration_credentials"("id") ON DELETE set null ON UPDATE no action;