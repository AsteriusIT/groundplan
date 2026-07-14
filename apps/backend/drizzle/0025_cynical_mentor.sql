ALTER TABLE "clusters" DROP CONSTRAINT "clusters_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "clusters" DROP COLUMN "project_id";