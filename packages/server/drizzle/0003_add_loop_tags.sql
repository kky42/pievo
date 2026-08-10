ALTER TABLE "loops" ADD COLUMN "tags" text[] DEFAULT ARRAY[]::text[] NOT NULL;
--> statement-breakpoint
ALTER TABLE "loops" ADD CONSTRAINT "loops_tags_count_check" CHECK (cardinality("loops"."tags") <= 4);
--> statement-breakpoint
ALTER TABLE "loops" ADD CONSTRAINT "loops_tags_reserved_check" CHECK (NOT ("loops"."tags" && ARRAY['all loops', 'active', 'paused', 'blocked']::text[]));
