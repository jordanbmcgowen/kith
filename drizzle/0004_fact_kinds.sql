-- Work and travel become fact kinds of their own.
--
-- They were the two subjects that come up in almost every note and had
-- nowhere to land: where someone works went to "history" (which also means
-- alma mater) or "context" (which means everything), and a trip had no home
-- at all. "relation" already existed and stays; the extraction prompt is what
-- widens it to named friends, not just family.
--
-- Additive only. ALTER TYPE ... ADD VALUE cannot lose a row: every existing
-- fact keeps the kind it has, and nothing reads these two until the model or
-- the user writes them.
ALTER TYPE "public"."fact_kind" ADD VALUE IF NOT EXISTS 'work';--> statement-breakpoint
ALTER TYPE "public"."fact_kind" ADD VALUE IF NOT EXISTS 'travel';
