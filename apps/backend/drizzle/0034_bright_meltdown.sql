ALTER TABLE "confluence_connections" ADD COLUMN "page_id" text;--> statement-breakpoint
ALTER TABLE "confluence_connections" ADD COLUMN "page_url" text;--> statement-breakpoint
ALTER TABLE "confluence_connections" ADD COLUMN "last_published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "confluence_connections" ADD COLUMN "last_publish_error" text;