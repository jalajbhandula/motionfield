-- 0400: refs — elements gain a sub-kind (person | outfit | prop | place) so a
-- ref can say what *part* of a scene it is, not just its top-level category.
ALTER TABLE elements ADD COLUMN IF NOT EXISTS kind text;
