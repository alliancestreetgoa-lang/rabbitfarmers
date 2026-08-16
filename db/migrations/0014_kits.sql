-- ============================================================================
-- Individual kits
--
-- A litter has always been counts: born alive, born dead, weaned. That is the
-- right shape for the first thirty days, when the kits are a heap of fur in a
-- nest box and nobody is going to tag eight of them.
--
-- It stops being the right shape the moment one is kept back for breeding. Her
-- mother is a number in a row, so the inbreeding check cannot see it, the buck
-- suggestion cannot warn about it, and the farm's own pedigree begins at
-- whatever day someone typed her in by hand.
--
-- So kits become individuals at weaning — the moment they are separated, put in
-- their own cage and become animals a person deals with one at a time.
--
-- ---------------------------------------------------------------------------
-- Sex has to be allowed to be unknown
--
-- rabbit.sex is NOT NULL over an enum of exactly 'doe' and 'buck'. Creating
-- seven kits therefore demands seven guesses. At 30 days sexing is fiddly and
-- often wrong, and most farms do it properly at eight to twelve weeks — so the
-- guess would be recorded as fact, and a buck filed as a doe sits in the
-- ready-to-mate queue for two months waiting to kindle.
--
-- 'unknown' is a real state on a real farm, so the enum should say so. Every
-- view that selects breeding stock already filters sex = 'doe' or 'buck', which
-- means an unsexed grower is silently and correctly excluded from all of them
-- without a single one needing to change.
--
-- ALTER TYPE ... ADD VALUE runs inside a transaction on PostgreSQL 12 and up so
-- long as the new value is not used in the same transaction. Nothing here uses
-- it; the first 'unknown' row is written by the API afterwards.
-- ============================================================================

ALTER TYPE sex_t ADD VALUE IF NOT EXISTS 'unknown';

-- ----------------------------------------------------------------------------
-- v_litter_kits — how many of a litter are recorded as individuals
--
-- The gap between weaned_count and this is what the app offers to close.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_litter_kits AS
SELECT
    l.id                                    AS litter_id,
    l.farm_id,
    l.doe_id,
    l.kindled_on,
    l.born_alive,
    l.weaned_on,
    l.weaned_count,
    -- What the farm believes it has: the weaned count once they are separated,
    -- the live birth count before that.
    COALESCE(l.weaned_count, l.born_alive)  AS expected,
    count(k.id)                             AS recorded,
    GREATEST(COALESCE(l.weaned_count, l.born_alive) - count(k.id), 0) AS not_yet_recorded
FROM litter l
LEFT JOIN rabbit k ON k.litter_id = l.id AND k.status <> 'dead'
GROUP BY l.id;

ALTER VIEW v_litter_kits SET (security_invoker = true);

-- An index for it: without this, listing kits means a sequential scan of the
-- whole herd once per litter.
CREATE INDEX IF NOT EXISTS rabbit_litter_idx ON rabbit (litter_id)
    WHERE litter_id IS NOT NULL;
