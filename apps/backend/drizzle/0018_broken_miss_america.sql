CREATE TYPE "public"."annotation_provenance" AS ENUM('human', 'ai');--> statement-breakpoint
ALTER TYPE "public"."annotation_status" ADD VALUE 'proposed';--> statement-breakpoint
ALTER TYPE "public"."annotation_type" ADD VALUE 'hide';--> statement-breakpoint
ALTER TYPE "public"."annotation_type" ADD VALUE 'rename';--> statement-breakpoint
ALTER TABLE "annotations" ADD COLUMN "provenance" "annotation_provenance" DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "annotations" ADD COLUMN "created_from_sha" text;--> statement-breakpoint
ALTER TABLE "annotations" ADD COLUMN "parent_group_id" uuid;--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_parent_group_id_annotations_id_fk" FOREIGN KEY ("parent_group_id") REFERENCES "public"."annotations"("id") ON DELETE set null ON UPDATE no action;