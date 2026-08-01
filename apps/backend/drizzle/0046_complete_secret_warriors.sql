CREATE TYPE "public"."catalog_extraction_status" AS ENUM('pending', 'extracting', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."catalog_resource_kind" AS ENUM('resource', 'data_source');--> statement-breakpoint
CREATE TABLE "catalog_provider_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"version" text NOT NULL,
	"status" "catalog_extraction_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"extracted_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_provider_versions_unique" UNIQUE("provider_id","version")
);
--> statement-breakpoint
CREATE TABLE "catalog_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"namespace" text NOT NULL,
	"name" text NOT NULL,
	"allowlisted" boolean DEFAULT true NOT NULL,
	"latest_known_version" text,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_providers_ref_unique" UNIQUE("namespace","name")
);
--> statement-breakpoint
CREATE TABLE "catalog_resource_schemas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_type_id" uuid NOT NULL,
	"schema" "bytea" NOT NULL,
	"raw_bytes" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "catalog_resource_schemas_type_unique" UNIQUE("resource_type_id")
);
--> statement-breakpoint
CREATE TABLE "catalog_resource_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "catalog_resource_kind" NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"attribute_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "catalog_resource_types_unique" UNIQUE("version_id","name","kind")
);
--> statement-breakpoint
ALTER TABLE "catalog_provider_versions" ADD CONSTRAINT "catalog_provider_versions_provider_id_catalog_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."catalog_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_resource_schemas" ADD CONSTRAINT "catalog_resource_schemas_resource_type_id_catalog_resource_types_id_fk" FOREIGN KEY ("resource_type_id") REFERENCES "public"."catalog_resource_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_resource_types" ADD CONSTRAINT "catalog_resource_types_version_id_catalog_provider_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."catalog_provider_versions"("id") ON DELETE cascade ON UPDATE no action;