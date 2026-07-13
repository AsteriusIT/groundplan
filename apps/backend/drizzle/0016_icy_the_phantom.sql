CREATE TYPE "public"."ai_generation_kind" AS ENUM('pr_summary', 'docs_explain');--> statement-breakpoint
CREATE TABLE "ai_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "ai_generation_kind" NOT NULL,
	"target_id" text NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"output" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_generations_cache_key_unique" UNIQUE("kind","target_id","prompt_version","model")
);
