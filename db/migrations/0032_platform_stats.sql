-- ============================================================================
-- Platform statistics, per farm and in total, over a date range
--
-- The product is given away to collect this. Until now the admin console could
-- answer "how many animals" and "how many staff" and nothing else: no split
-- between bucks and does, no pregnancies, no kits, and no way to ask about a
-- period. v_admin_revenue_summary answered the only question that mattered when
-- there was money, and after 0031 it reports ₹0 for ever.
--
-- FUNCTIONS, NOT VIEWS, for one reason: a view cannot take a date range. Both
-- take (from, to) and NULL on either side means unbounded, so a caller asking
-- nothing gets all of history rather than an error or an empty set.
--
-- SECURITY. These are deliberately NOT `SECURITY DEFINER`.
--
--   A definer-rights function would run as the migration role and hand every
--   farm's herd to whoever called it — the same hole 0008 was written to close,
--   reopened one layer up where the isolation tests do not look. Instead they
--   run as the caller and EXECUTE is granted only to rabbitry_admin. The
--   platform admin connects as admin_login, which holds BYPASSRLS, so it sees
--   every farm. rabbitry_app is not granted execute at all, so a farmer cannot
--   call these even to see their own row.
--
-- DEFINITIONS, stated because "how many rabbits" has more than one answer:
--
--   On the farm  = status IN ('active','quarantine'), matching the count that
--                  v_admin_farm_overview has always reported. Sold, culled and
--                  dead animals are history, not herd.
--   Kits         = counted from litter.born_alive, not from rabbit rows. Kits
--                  are only promoted to individual rabbit rows when somebody
--                  records them one by one, which most farms do late or never;
--                  counting rabbit rows would under-report every young litter.
--   Born in range = litter.kindled_on within the range. Weaned in range is a
--                  separate column keyed on weaned_on, because the two events
--                  are weeks apart and summing them together is meaningless.
-- ============================================================================

CREATE OR REPLACE FUNCTION admin_farm_stats(
    p_from date DEFAULT NULL,
    p_to   date DEFAULT NULL)
RETURNS TABLE (
    farm_id                  uuid,
    farm_name                text,
    city                     text,
    state                    text,
    signed_up_at             timestamptz,
    owner_name               text,
    owner_email              text,
    owner_phone              text,
    -- people
    staff_total              int,
    -- the herd as it stands today
    animals_total            int,
    bucks                    int,
    does                     int,
    sex_unknown              int,
    breeders                 int,
    replacements             int,
    growers                  int,
    -- reproduction as it stands today
    pregnant_total           int,
    pregnant_confirmed       int,
    pregnant_presumed        int,
    due_within_7_days        int,
    ready_to_mate            int,
    kits_unweaned            int,
    litters_open             int,
    open_conditions          int,
    -- what happened inside the range
    matings_in_range         int,
    litters_in_range         int,
    kits_born_alive_in_range int,
    kits_born_dead_in_range  int,
    kits_weaned_in_range     int,
    animals_added_in_range   int,
    died_in_range            int,
    culled_in_range          int,
    sold_in_range            int,
    -- is this farm still alive
    last_activity_at         timestamptz,
    days_since_activity      int)
LANGUAGE sql
STABLE
AS $$
    SELECT
        f.id, f.name, f.city, f.state, f.created_at,
        owner.full_name, owner.email, owner.phone,
        ppl.staff_total,
        herd.animals_total, herd.bucks, herd.does, herd.sex_unknown,
        herd.breeders, herd.replacements, herd.growers,
        COALESCE(ps.total_pregnant, 0)::int,
        COALESCE(ps.confirmed_pregnant, 0)::int,
        COALESCE(ps.presumed_pregnant, 0)::int,
        COALESCE(ps.due_within_7_days, 0)::int,
        rdy.ready_to_mate,
        kn.kits_unweaned, kn.litters_open,
        hc.open_conditions,
        mr.matings,
        lr.litters, lr.kits_born_alive, lr.kits_born_dead,
        wr.kits_weaned,
        ar.animals_added,
        xr.died, xr.culled, xr.sold,
        act.last_activity_at,
        CASE WHEN act.last_activity_at IS NULL THEN NULL
             ELSE (current_date - act.last_activity_at::date) END
    FROM farm f
    CROSS JOIN LATERAL (
        SELECT COALESCE(p_from, '-infinity'::date) AS lo,
               COALESCE(p_to,   'infinity'::date)  AS hi
    ) b
    LEFT JOIN LATERAL (
        SELECT em.full_name, em.email, em.phone
        FROM employee em
        WHERE em.farm_id = f.id AND em.role = 'owner'
        ORDER BY em.created_at
        LIMIT 1
    ) owner ON true
    CROSS JOIN LATERAL (
        SELECT count(*)::int AS staff_total
        FROM employee em WHERE em.farm_id = f.id AND em.is_active
    ) ppl
    CROSS JOIN LATERAL (
        SELECT count(*)::int                                              AS animals_total,
               count(*) FILTER (WHERE r.sex = 'buck')::int                AS bucks,
               count(*) FILTER (WHERE r.sex = 'doe')::int                 AS does,
               count(*) FILTER (WHERE r.sex = 'unknown')::int             AS sex_unknown,
               count(*) FILTER (WHERE r.role = 'breeder')::int            AS breeders,
               count(*) FILTER (WHERE r.role = 'replacement')::int        AS replacements,
               count(*) FILTER (WHERE r.role = 'grower')::int             AS growers
        FROM rabbit r
        WHERE r.farm_id = f.id
          AND r.status IN ('active', 'quarantine')
    ) herd
    LEFT JOIN v_pregnancy_summary ps ON ps.farm_id = f.id
    CROSS JOIN LATERAL (
        SELECT count(*)::int AS ready_to_mate
        FROM v_ready_to_mate rm WHERE rm.farm_id = f.id
    ) rdy
    CROSS JOIN LATERAL (
        SELECT COALESCE(sum(l.born_alive), 0)::int AS kits_unweaned,
               count(*)::int                       AS litters_open
        FROM litter l WHERE l.farm_id = f.id AND l.weaned_on IS NULL
    ) kn
    CROSS JOIN LATERAL (
        SELECT count(*)::int AS open_conditions
        FROM v_open_conditions oc WHERE oc.farm_id = f.id
    ) hc
    CROSS JOIN LATERAL (
        SELECT count(*)::int AS matings
        FROM mating m
        WHERE m.farm_id = f.id AND m.mated_at::date BETWEEN b.lo AND b.hi
    ) mr
    CROSS JOIN LATERAL (
        SELECT count(*)::int                       AS litters,
               COALESCE(sum(l.born_alive), 0)::int AS kits_born_alive,
               COALESCE(sum(l.born_dead), 0)::int  AS kits_born_dead
        FROM litter l
        WHERE l.farm_id = f.id AND l.kindled_on BETWEEN b.lo AND b.hi
    ) lr
    CROSS JOIN LATERAL (
        SELECT COALESCE(sum(l.weaned_count), 0)::int AS kits_weaned
        FROM litter l
        WHERE l.farm_id = f.id AND l.weaned_on BETWEEN b.lo AND b.hi
    ) wr
    CROSS JOIN LATERAL (
        SELECT count(*)::int AS animals_added
        FROM rabbit r
        WHERE r.farm_id = f.id AND r.created_at::date BETWEEN b.lo AND b.hi
    ) ar
    CROSS JOIN LATERAL (
        SELECT count(*) FILTER (WHERE r.status = 'dead')::int   AS died,
               count(*) FILTER (WHERE r.status = 'culled')::int AS culled,
               count(*) FILTER (WHERE r.status = 'sold')::int   AS sold
        FROM rabbit r
        WHERE r.farm_id = f.id
          AND r.status_changed_on BETWEEN b.lo AND b.hi
    ) xr
    CROSS JOIN LATERAL (
        -- Same proxy v_admin_farm_overview uses: the most recent write of any
        -- kind. For a data-collection platform this is the single most useful
        -- column here, because it names the farms that have gone quiet.
        SELECT max(t) AS last_activity_at FROM (
            SELECT max(created_at) FROM mating           WHERE farm_id = f.id
            UNION ALL SELECT max(created_at) FROM litter WHERE farm_id = f.id
            UNION ALL SELECT max(created_at) FROM health_condition WHERE farm_id = f.id
            UNION ALL SELECT max(created_at) FROM rabbit WHERE farm_id = f.id
        ) x(t)
    ) act
    ORDER BY f.created_at DESC;
$$;

COMMENT ON FUNCTION admin_farm_stats(date, date) IS
    'One row per farm: people, herd by sex and role, pregnancies, kits, and '
    'what happened between from and to. NULL bounds mean unbounded. Admin only.';


-- ----------------------------------------------------------------------------
-- The whole platform in one row.
--
-- Built on admin_farm_stats so the two can never disagree — a total that is
-- computed separately from the rows beneath it is a total that eventually
-- contradicts them.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_platform_stats(
    p_from date DEFAULT NULL,
    p_to   date DEFAULT NULL)
RETURNS TABLE (
    farms_total              int,
    farms_active_in_range    int,
    farms_silent_14d         int,
    farms_never_recorded     int,
    staff_total              int,
    animals_total            int,
    bucks                    int,
    does                     int,
    breeders                 int,
    pregnant_total           int,
    pregnant_confirmed       int,
    pregnant_presumed        int,
    ready_to_mate            int,
    kits_unweaned            int,
    open_conditions          int,
    matings_in_range         int,
    litters_in_range         int,
    kits_born_alive_in_range int,
    kits_born_dead_in_range  int,
    kits_weaned_in_range     int,
    animals_added_in_range   int,
    died_in_range            int,
    culled_in_range          int,
    sold_in_range            int)
LANGUAGE sql
STABLE
AS $$
    SELECT
        count(*)::int,
        -- "Active" means recorded something inside the window, which is the
        -- only definition that survives the product being free: there is no
        -- subscription status left that means anything.
        count(*) FILTER (WHERE s.matings_in_range > 0
                            OR s.litters_in_range > 0
                            OR s.animals_added_in_range > 0)::int,
        count(*) FILTER (WHERE s.days_since_activity >= 14)::int,
        count(*) FILTER (WHERE s.last_activity_at IS NULL)::int,
        COALESCE(sum(s.staff_total), 0)::int,
        COALESCE(sum(s.animals_total), 0)::int,
        COALESCE(sum(s.bucks), 0)::int,
        COALESCE(sum(s.does), 0)::int,
        COALESCE(sum(s.breeders), 0)::int,
        COALESCE(sum(s.pregnant_total), 0)::int,
        COALESCE(sum(s.pregnant_confirmed), 0)::int,
        COALESCE(sum(s.pregnant_presumed), 0)::int,
        COALESCE(sum(s.ready_to_mate), 0)::int,
        COALESCE(sum(s.kits_unweaned), 0)::int,
        COALESCE(sum(s.open_conditions), 0)::int,
        COALESCE(sum(s.matings_in_range), 0)::int,
        COALESCE(sum(s.litters_in_range), 0)::int,
        COALESCE(sum(s.kits_born_alive_in_range), 0)::int,
        COALESCE(sum(s.kits_born_dead_in_range), 0)::int,
        COALESCE(sum(s.kits_weaned_in_range), 0)::int,
        COALESCE(sum(s.animals_added_in_range), 0)::int,
        COALESCE(sum(s.died_in_range), 0)::int,
        COALESCE(sum(s.culled_in_range), 0)::int,
        COALESCE(sum(s.sold_in_range), 0)::int
    FROM admin_farm_stats(p_from, p_to) s;
$$;

COMMENT ON FUNCTION admin_platform_stats(date, date) IS
    'The whole platform in one row, summed from admin_farm_stats. Admin only.';


-- Admin only, on purpose. rabbitry_app is deliberately absent: a farmer has no
-- business running a platform-wide query, and RLS filtering the answer down to
-- their own farm is not a reason to offer it.
GRANT EXECUTE ON FUNCTION admin_farm_stats(date, date)     TO rabbitry_admin;
GRANT EXECUTE ON FUNCTION admin_platform_stats(date, date) TO rabbitry_admin;
