CREATE TABLE "capture_jobs" (
	"user_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"capture_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"review" boolean DEFAULT false NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"finished_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "capture_jobs_user_id_request_key_pk" PRIMARY KEY("user_id","request_key"),
	CONSTRAINT "capture_jobs_lease_pair" CHECK (("capture_jobs"."lease_token" is null) = ("capture_jobs"."lease_until" is null))
);
--> statement-breakpoint
ALTER TABLE "capture_jobs" ADD CONSTRAINT "capture_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_jobs" ADD CONSTRAINT "capture_jobs_capture_id_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."captures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "capture_jobs_one_active" ON "capture_jobs" USING btree ("capture_id") WHERE "capture_jobs"."finished_at" is null;--> statement-breakpoint
CREATE INDEX "capture_jobs_due" ON "capture_jobs" USING btree ("available_at") WHERE "capture_jobs"."finished_at" is null;
--> statement-breakpoint
-- Adopt only unfinished legacy captures. Re-read into review, retaining raw
-- data and old derived rows. Old queue messages use capture_id as request_key.
INSERT INTO "capture_jobs" ("user_id", "request_key", "capture_id", "request_hash", "review")
SELECT "user_id", "id", "id", 'legacy', true FROM "captures"
WHERE "status" IN ('uploaded', 'transcribing', 'extracting');
