-- WS5 s6: refs_read backfill — rows saved before the column existed (0505)
-- carry false even when a vision pass described their refs at create time.
-- A ref's `description` is only written by the vision pass, so a scene whose
-- refs hold at least one description provably had one — flip those rows on.
UPDATE stage_scenes
SET refs_read = true
WHERE refs_read = false
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(refs) AS r
    WHERE r ->> 'description' IS NOT NULL
  );
