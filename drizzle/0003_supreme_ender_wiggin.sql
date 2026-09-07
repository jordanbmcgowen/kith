ALTER TABLE "people" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "people_tags_idx" ON "people" USING gin ("tags");