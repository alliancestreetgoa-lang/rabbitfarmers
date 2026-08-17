/** Shapes returned by the API. Kept in one place so the screens stay honest. */

/** 'unknown' is a real state — a kit nobody has sexed yet. See migration 0014. */
export type Sex = 'doe' | 'buck' | 'unknown';
export type Urgency = 'critical' | 'high' | 'medium' | 'low';

export type ReproductiveState =
  | 'GROWING' | 'READY' | 'MATED' | 'PREGNANT' | 'NEST_BOX'
  | 'LACTATING' | 'PSEUDOPREGNANT' | 'OPEN' | 'RESTING' | 'OVERDUE';

/**
 * Somebody from Rabbitry support is on the other end of this session.
 *
 * Present only on a session handed over by the admin console. The app shows it
 * and refuses to open any screen that writes — not because the server would
 * allow it (it refuses too) but because the farmer is entitled to see, on their
 * own screen, that a stranger is looking.
 */
export interface SupportAccess {
  /** The support person's name, as it appears in the audit log. */
  by: string;
  expires_at: string;
  read_only: boolean;
}

export interface Session {
  token: string;
  farm: { id: string; name?: string };
  user: { id: string; name: string; email?: string; role: string };
  support?: SupportAccess | null;
}

export interface Animal {
  id: string;
  tag: string;
  name: string | null;
  sex: Sex;
  role: string;
  /** active | quarantine | sold | culled | dead. Never deleted. */
  status: string;
  /** When she left the herd, for the three statuses that mean she has. */
  status_changed_on?: string | null;
  date_of_birth: string | null;
  breed: string | null;
  cage: string | null;
  reproductive_state: ReproductiveState | null;
  confidence: 'confirmed' | 'presumed' | null;
  expected_kindling_on: string | null;
  /** Colour mark from an open health condition. Always shown with the words. */
  primary_colour: string | null;
  primary_condition: string | null;
  conditions: string[] | null;
}

export interface Breed {
  id: string;
  name: string;
  size_class: string;
  doe_first_mating_days: number;
  buck_first_mating_days: number;
  /** How many living rabbits carry it — the list is ordered by this. */
  animals: number;
}

export interface Cage {
  id: string;
  /** What is painted on the cage card. */
  code: string;
  row_label: string | null;
  capacity: number;
  shed: string;
  occupants: number;
}

export interface LitterCorrection {
  changed_at: string;
  changed_by: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
}

export interface Litter {
  id: string;
  doe_id: string;
  doe_name: string | null;
  doe_tag: string;
  mating_id: string | null;
  kindled_on: string;
  nest_box_placed_on: string | null;
  born_alive: number;
  born_dead: number;
  fostered_in: number;
  fostered_out: number;
  weaned_on: string | null;
  weaned_count: number | null;
  avg_weaning_weight_g: number | null;
  notes: string | null;
  separate_kits_on: string;
  rebreed_on: string;
  /** Every time this record has been corrected, newest first. */
  corrections: LitterCorrection[];
}

/** One line of a rabbit's timeline. `detail` varies by kind. */
export interface HistoryEvent {
  on_date: string;
  kind: 'born' | 'mating' | 'service' | 'pregnancy_check' | 'kindling'
      | 'weaning' | 'weight' | 'health_event' | 'condition' | 'moved' | 'status'
      /** A record that was edited. Carries `before` and `after`. */
      | 'correction';
  title: string;
  detail: Record<string, unknown>;
}

export interface RabbitLifetime {
  status: string;
  date_of_birth: string | null;
  age_days: number | null;
  left_herd_on: string | null;
  matings: number;
  services: number;
  litters: number;
  born_alive: number;
  weaned: number;
  /** NULL until she has been in service 180 days — see migration 0012. */
  weaned_per_year: number | null;
  days_in_service: number | null;
  illnesses: number;
  treatments: number;
}

export interface PregnancySummary {
  total_pregnant: number;
  confirmed_pregnant: number;
  presumed_pregnant: number;
  due_within_7_days: number;
}

export interface PregnantDoe {
  rabbit_id: string;
  tag: string;
  name: string | null;
  state: ReproductiveState;
  confidence: 'confirmed' | 'presumed' | null;
  gestation_day: number;
  expected_kindling_on: string;
  window_start_on: string;
  window_end_on: string;
}

export interface ReadyDoe {
  rabbit_id: string;
  tag: string;
  name: string | null;
  state: ReproductiveState;
  days_since_last_kindling: number | null;
  days_since_weaning: number | null;
  days_overdue: number | null;
  last_observed_receptivity: string | null;
  total_weaned: number | null;
  litters: number | null;
}

export interface BuckSuggestion {
  buck_id: string;
  tag: string;
  name: string | null;
  services_today: number;
  services_last_7d: number;
  conception_rate: number | null;
  over_quota: boolean;
  blocked_related: boolean;
  warn_related: boolean;
}

export interface DailyItem {
  source: 'task' | 'medication' | 'condition';
  ref_id: string;
  rabbit_id: string | null;
  tag: string | null;
  due_on: string;
  due_at: string | null;
  title: string;
  urgency: Urgency;
  colour: string | null;
}

export interface MedicationDose {
  protocol_id: string;
  protocol_name: string;
  rabbit_id: string;
  rabbit_name: string | null;
  tag: string;
  dose_number: number;
  total_doses: number;
  due_on: string;
  /** Negative when the dose is late. */
  days_until_due: number;
  dose_note: string | null;
}

export interface OpenCondition {
  condition_id: string;
  rabbit_id: string | null;
  tag: string | null;
  rabbit_name: string | null;
  condition_name: string;
  colour: string;
  severity: string | null;
  hours_open: number;
  next_reminder_at: string | null;
  reminder_due: boolean;
  needs_escalation: boolean;
}

export interface Subscription {
  plan_code: string | null;
  status: string | null;
  billing_period: string | null;
  access: 'full' | 'read_only';
  trial_days_left: number | null;
  current_period_end: string | null;
  effective_price_paise: number | null;
  is_grandfathered: boolean | null;
}

export interface MatingSchedule {
  palpate_on: string;
  nest_box_on: string;
  expected_kindling_on: string;
  watch_until: string;
}

/* --------------------------------------------------------------------- team */

/** The five roles from docs/04. Enforced by the API, mirrored here for the UI. */
export type StaffRole = 'owner' | 'manager' | 'caretaker' | 'vet' | 'accountant';

export interface Staff {
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
  role: StaffRole;
  employment_type: string;
  joined_on: string | null;
  left_on: string | null;
  language: string;
  can_palpate: boolean;
  is_active: boolean;
  /** They have a password. Plenty of staff never need one. */
  can_sign_in: boolean;
  /** Sheds they look after — what auto-assigns their work. */
  sheds: string[];
  shed_ids: string[];
  today_status: string | null;
  today_checked_in_at: string | null;
  today_checked_out_at: string | null;
  open_tasks: number;
}

export interface Shed {
  id: string;
  name: string;
  cages?: number;
  animals?: number;
  caretakers?: string[];
}

export interface Attendance {
  id: string;
  employee_id: string;
  work_date: string;
  status: string;
  checked_in_at: string | null;
  checked_out_at: string | null;
  overtime_minutes: number;
  note: string | null;
}

export interface AttendanceSummary {
  employee_id: string;
  full_name: string;
  month: string;
  present: number;
  half_days: number;
  absent: number;
  leave: number;
  holiday: number;
  overtime_minutes: number;
  days_worked: string;
}

/** One line of what a farm has paid, and the invoice it produced. */
export interface BillingRow {
  id: string;
  created_at: string;
  paid_at: string | null;
  status: 'created' | 'paid' | 'failed' | 'cancelled' | 'refunded';
  amount_paise: number;
  billing_period: string;
  covers_days: number;
  short_url: string | null;
  failed_reason: string | null;
  invoice_number: string | null;
  period_start: string | null;
  period_end: string | null;
  subtotal_paise: number | null;
  tax_paise: number | null;
  /* Money that came back, and the credit note that says so. Null on every
     payment that was never refunded, which is almost all of them. */
  refunded_paise: number | null;
  credit_note_number: string | null;
  refunded_at: string | null;
}
