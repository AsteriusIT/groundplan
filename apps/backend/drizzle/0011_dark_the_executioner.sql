ALTER TABLE "repositories" ADD COLUMN "pr_comments_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "last_comment_error" text;