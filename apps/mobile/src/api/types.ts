/** Shapes returned by the API. Kept in one place so the screens stay honest. */

export type Sex = 'doe' | 'buck';
export type Urgency = 'critical' | 'high' | 'medium' | 'low';

export type ReproductiveState =
  | 'GROWING' | 'READY' | 'MATED' | 'PREGNANT' | 'NEST_BOX'
  | 'LACTATING' | 'PSEUDOPREGNANT' | 'OPEN' | 'RESTING' | 'OVERDUE';

export interface Session {
  token: string;
  farm: { id: string; name?: string };
  user: { id: string; name: string; email?: string; role: string };
}

export interface Animal {
  id: string;
  tag: string;
  name: string | null;
  sex: Sex;
  role: string;
  status: string;
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
