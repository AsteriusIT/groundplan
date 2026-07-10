CREATE TYPE "public"."repository_connection_status" AS ENUM('unverified', 'ok', 'failed');--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "connection_status" "repository_connection_status" DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "verified_at" timestamp with time zone;