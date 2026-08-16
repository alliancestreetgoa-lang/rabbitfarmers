-- ============================================================================
-- Seed data required for the app to function at all.
--
-- Idempotent: safe to run on every deploy.
-- ============================================================================

-- The plan that is currently on sale. Introductory pricing — see
-- docs/09-saas-model.md. Raising the price means INSERTing a new row and
-- setting available_until on this one, never editing these numbers in place.
INSERT INTO plan (code, name, max_breeding_does, max_staff_seats,
                  price_monthly_paise, price_yearly_paise, is_introductory, sort_order)
VALUES ('intro-2026', 'Rabbitry', NULL, NULL, 9900, 99900, true, 1)
ON CONFLICT (code) DO NOTHING;
