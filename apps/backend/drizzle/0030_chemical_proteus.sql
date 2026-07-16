-- GP-114: clusters become org-scoped. Same safe backfill as projects (0029):
-- add nullable, attach every existing cluster to the "Default" org, enforce.
-- Inert on a fresh DB (no clusters to attach).
ALTER TABLE "clusters" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
UPDATE "clusters" SET "organization_id" = (SELECT "id" FROM "organizations" WHERE "slug" = 'default') WHERE "organization_id" IS NULL;--> statement-breakpoint
ALTER TABLE "clusters" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
