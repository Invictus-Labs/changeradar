-- ChangeRadar schema, part 4: bounded findings (review round 1).
-- A finding's stored path keeps the first and last hops of a very long path, and its change id list is capped.
-- These columns say how much was left out, so an elided path or list is never mistaken for a complete one.
ALTER TABLE findings ADD COLUMN path_omitted_hops integer NOT NULL DEFAULT 0 CHECK (path_omitted_hops >= 0);
ALTER TABLE findings ADD COLUMN change_ids_omitted integer NOT NULL DEFAULT 0 CHECK (change_ids_omitted >= 0);
