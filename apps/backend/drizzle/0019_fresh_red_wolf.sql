ALTER TYPE "public"."ai_generation_kind" ADD VALUE 'annotation_proposals';--> statement-breakpoint
ALTER TABLE "annotations" ADD COLUMN "reason" text;