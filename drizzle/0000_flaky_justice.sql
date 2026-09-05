CREATE TYPE "public"."capture_kind" AS ENUM('voice', 'text', 'photo', 'calendar');--> statement-breakpoint
CREATE TYPE "public"."capture_status" AS ENUM('uploaded', 'transcribing', 'extracting', 'needs_review', 'filed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."circle_kind" AS ENUM('family', 'friends', 'work', 'neighbors', 'other');--> statement-breakpoint
CREATE TYPE "public"."fact_kind" AS ENUM('identity', 'relation', 'preference', 'history', 'sensitive', 'context');--> statement-breakpoint
CREATE TYPE "public"."place_kind" AS ENUM('home', 'work', 'venue', 'city', 'other');--> statement-breakpoint
CREATE TYPE "public"."thread_status" AS ENUM('open', 'done', 'dropped');--> statement-breakpoint
CREATE TABLE "accounts" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"google_event_id" text NOT NULL,
	"title" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"location" text,
	"attendees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prompted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "capture_kind" NOT NULL,
	"status" "capture_status" DEFAULT 'uploaded' NOT NULL,
	"audio_key" text,
	"duration_sec" real,
	"transcript" text,
	"raw_text" text,
	"lat" double precision,
	"lng" double precision,
	"accuracy_m" real,
	"place_id" uuid,
	"captured_at" timestamp with time zone NOT NULL,
	"extraction" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"person_id" uuid,
	"kind" "fact_kind" DEFAULT 'context' NOT NULL,
	"content" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"capture_id" uuid,
	"superseded_by_id" uuid,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"person_id" uuid,
	"capture_id" uuid,
	"place_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"channel" text DEFAULT 'in_person' NOT NULL,
	"summary" text NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"google_event_id" text,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loose_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"capture_id" uuid,
	"content" text NOT NULL,
	"candidate_person_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resolved_person_id" uuid,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"goes_by" text,
	"pronunciation" text,
	"pronouns" text,
	"circle" "circle_kind" DEFAULT 'other' NOT NULL,
	"role" text,
	"company" text,
	"title" text,
	"avatar_url" text,
	"birthday" text,
	"cadence_days" integer,
	"last_interaction_at" timestamp with time zone,
	"warmth" integer DEFAULT 50 NOT NULL,
	"google_contact_id" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_places" (
	"person_id" uuid NOT NULL,
	"place_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "person_places_person_id_place_id_pk" PRIMARY KEY("person_id","place_id")
);
--> statement-breakpoint
CREATE TABLE "places" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "place_kind" DEFAULT 'venue' NOT NULL,
	"google_place_id" text,
	"lat" double precision,
	"lng" double precision,
	"radius_m" integer DEFAULT 120 NOT NULL,
	"visit_count" integer DEFAULT 0 NOT NULL,
	"last_visited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"sync_token" text,
	"last_run_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "sync_state_user_id_source_pk" PRIMARY KEY("user_id","source")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"person_id" uuid,
	"title" text NOT NULL,
	"due_at" timestamp with time zone,
	"status" "thread_status" DEFAULT 'open' NOT NULL,
	"closed_by_capture_id" uuid,
	"created_from_capture_id" uuid,
	"completed_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"email" text NOT NULL,
	"email_verified" timestamp with time zone,
	"image" text,
	"timezone" text DEFAULT 'America/Chicago' NOT NULL,
	"cadence_defaults" jsonb DEFAULT '{"family":14,"friends":21,"work":45,"neighbors":30,"other":90}'::jsonb NOT NULL,
	"onboarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loose_threads" ADD CONSTRAINT "loose_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loose_threads" ADD CONSTRAINT "loose_threads_capture_id_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."captures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loose_threads" ADD CONSTRAINT "loose_threads_resolved_person_id_people_id_fk" FOREIGN KEY ("resolved_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_places" ADD CONSTRAINT "person_places_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_places" ADD CONSTRAINT "person_places_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_places" ADD CONSTRAINT "person_places_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cal_user_event_idx" ON "calendar_events" USING btree ("user_id","google_event_id");--> statement-breakpoint
CREATE INDEX "cal_user_start_idx" ON "calendar_events" USING btree ("user_id","starts_at");--> statement-breakpoint
CREATE INDEX "captures_user_status_idx" ON "captures" USING btree ("user_id","status","captured_at");--> statement-breakpoint
CREATE INDEX "facts_person_idx" ON "facts" USING btree ("person_id","pinned");--> statement-breakpoint
CREATE INDEX "facts_user_idx" ON "facts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "facts_vec_idx" ON "facts" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "interactions_person_idx" ON "interactions" USING btree ("person_id","occurred_at");--> statement-breakpoint
CREATE INDEX "interactions_user_time_idx" ON "interactions" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "interactions_vec_idx" ON "interactions" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "loose_user_idx" ON "loose_threads" USING btree ("user_id","resolved_person_id","dismissed_at");--> statement-breakpoint
CREATE INDEX "people_user_idx" ON "people" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "people_google_idx" ON "people" USING btree ("user_id","google_contact_id");--> statement-breakpoint
CREATE INDEX "people_warmth_idx" ON "people" USING btree ("user_id","warmth");--> statement-breakpoint
CREATE INDEX "people_name_trgm_idx" ON "people" USING gin ("display_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "person_places_place_idx" ON "person_places" USING btree ("user_id","place_id","weight");--> statement-breakpoint
CREATE INDEX "places_user_idx" ON "places" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "places_user_google_idx" ON "places" USING btree ("user_id","google_place_id");--> statement-breakpoint
CREATE INDEX "places_geo_idx" ON "places" USING btree ("user_id","lat","lng");--> statement-breakpoint
CREATE INDEX "threads_due_idx" ON "threads" USING btree ("user_id","status","due_at");--> statement-breakpoint
CREATE INDEX "threads_person_idx" ON "threads" USING btree ("person_id","status");