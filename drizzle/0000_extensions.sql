-- Run this on Neon BEFORE the first generated migration.
CREATE EXTENSION IF NOT EXISTS vector;   -- pgvector, for fuzzy recall
CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- typo-tolerant name matching
