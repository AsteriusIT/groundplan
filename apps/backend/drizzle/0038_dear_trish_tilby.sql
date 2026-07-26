ALTER TYPE "public"."confluence_auth_type" ADD VALUE 'oauth';--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "last_error" text;