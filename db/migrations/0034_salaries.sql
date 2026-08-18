-- ============================================================================
-- 0034  Salaries
--
-- docs/04 deferred payroll and shipped the attendance CSV instead. This is the
-- next 20%: a set monthly salary per person, and a payslip computed from the
-- attendance that already exists — not a payroll system. No deductions, no PF,
-- no tax; the farmer who needs those has an accountant, and the accountant
-- gets the CSV.
--
-- Salary is a history, not a column on employee: "what were we paying Ravi in
-- March" is a question a wage dispute actually asks, and an UPDATE cannot
-- answer it. The current salary is simply the latest row.
-- ============================================================================

CREATE TABLE staff_salary (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id        uuid NOT NULL REFERENCES farm(id) ON DELETE CASCADE,
    employee_id    uuid NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    monthly_amount numeric(12,2) NOT NULL CHECK (monthly_amount >= 0),
    effective_from date NOT NULL,
    set_by         uuid REFERENCES employee(id),
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- The person being paid must belong to the same farm as the row.
ALTER TABLE staff_salary ADD CONSTRAINT staff_salary_same_farm
    FOREIGN KEY (farm_id, employee_id) REFERENCES employee (farm_id, id) ON DELETE CASCADE;

CREATE INDEX staff_salary_employee_idx ON staff_salary (employee_id, effective_from DESC);

ALTER TABLE staff_salary ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_salary FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_salary_tenant ON staff_salary
    USING (farm_id = current_farm_id())
    WITH CHECK (farm_id = current_farm_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON staff_salary TO rabbitry_app, rabbitry_admin;

-- What each person is on today: the latest row per person. Ties on the same
-- effective date go to the most recently entered — a same-day correction wins.
CREATE OR REPLACE VIEW v_current_salary AS
SELECT DISTINCT ON (ss.employee_id)
    ss.employee_id, ss.farm_id, ss.monthly_amount, ss.effective_from, ss.created_at
FROM staff_salary ss
ORDER BY ss.employee_id, ss.effective_from DESC, ss.created_at DESC;

ALTER VIEW v_current_salary SET (security_invoker = true);
