import { HttpError } from './auth.js';

/**
 * Who may do what, from docs/04-employee-module.md.
 *
 * This is here rather than in the app because a farm hand's phone is a shared
 * device in practice — it gets handed across a cage row with the screen still
 * unlocked. A permission that only hides a button is not a permission.
 *
 * One table, not a scattering of role checks on individual routes. A matrix you
 * can read in one screen is a matrix somebody will notice is wrong; fifteen
 * `if (role === 'owner')` scattered through two thousand lines is not.
 */

/** Every distinct thing a person can do. Named for the act, not the endpoint. */
export const ACTIONS = [
  'animals:read',      // the herd, a rabbit's history, the daily list
  'animals:write',     // add a rabbit, record a mating, a kindling, a weaning
  'health:write',      // report a condition, record a dose, resolve a case
  'tasks:complete',    // tick off assigned work
  'staff:read',        // see the team and who is in today
  'staff:write',       // add, edit, deactivate, give somebody a login
  'attendance:self',   // check yourself in and out
  'attendance:mark',   // mark somebody else present or on leave
  'settings:write',    // farm settings, timezone, breeding defaults
  'billing:read',      // what the farm pays
  'finance:write',     // reserved for sales and expenses; nothing uses it yet
];

/**
 * Roles in order of reach. `owner` is deliberately spelled out rather than
 * given a wildcard: a new action should have to be granted on purpose, and a
 * wildcard means every future capability silently lands on somebody.
 */
export const ROLE_ACTIONS = {
  owner: new Set(ACTIONS),

  // Runs the farm day to day. Not the money, not the settings that change how
  // the breeding engine behaves.
  manager: new Set([
    'animals:read', 'animals:write', 'health:write', 'tasks:complete',
    'staff:read', 'staff:write', 'attendance:self', 'attendance:mark',
    'billing:read',
  ]),

  // The farm hand. The whole app, minus anything about other people.
  caretaker: new Set([
    'animals:read', 'animals:write', 'health:write', 'tasks:complete',
    'attendance:self',
  ]),

  // Reads everything about the animals, writes only health. Explicitly not
  // breeding decisions: a vet advising on a mating is fine, a vet recording one
  // as though the farm decided it is not.
  vet: new Set(['animals:read', 'health:write']),

  // The herd summary and the money. No individual animal records, no health
  // data — see the permission table in docs/04.
  accountant: new Set(['billing:read', 'finance:write', 'staff:read']),
};

/** Does this session's role permit this action? */
export function can(session, action) {
  return ROLE_ACTIONS[session?.role]?.has(action) ?? false;
}

/**
 * Route guard. `requireCan('staff:write')` reads as what it enforces.
 *
 * The message names the role rather than the action, because the person reading
 * it is a farm hand who tapped something and needs to know who to ask.
 */
export function requireCan(action) {
  return async (c, next) => {
    const session = c.get('session');
    if (!can(session, action)) {
      throw new HttpError(403, refusal(action, session?.role), {
        action, role: session?.role ?? null,
      });
    }
    await next();
  };
}

function refusal(action, role) {
  const who = [...Object.entries(ROLE_ACTIONS)]
    .filter(([, actions]) => actions.has(action))
    .map(([name]) => name);
  const asA = role ? ` as a ${role}` : '';
  return who.length
    ? `You cannot do that${asA}. Ask ${who.length === 1 ? 'the ' + who[0] : 'an ' + who.join(' or a ')}.`
    : `That is not something anybody can do yet.`;
}

/**
 * How long a farm hand may correct their own entry before it locks.
 *
 * From docs/04, and the reasoning is worth keeping next to the number: without
 * a window, mistakes are never corrected — asking a manager is embarrassing, so
 * the wrong weight stays. With an unlimited one, history is quietly rewritten,
 * which is worse. A day is long enough to notice at evening feed and short
 * enough that the record has settled by the time anyone relies on it.
 */
export const EDIT_WINDOW_HOURS = 24;

/**
 * May this session edit a record somebody already wrote?
 *
 * Owners and managers always may — correcting old records is most of what a
 * manager is for. Everyone else may correct their own, for a day.
 *
 * `recordedBy` null means nobody is recorded as having written it, which is
 * true of anything created before staff existed. Those are treated as the
 * farm's rather than nobody's, so a caretaker cannot rewrite them.
 */
export function canEditRecord(session, { recordedBy, createdAt }) {
  if (session.role === 'owner' || session.role === 'manager') return { ok: true };

  if (!recordedBy || recordedBy !== session.employeeId) {
    return { ok: false, reason: 'That was recorded by somebody else. A manager can change it.' };
  }

  const age = Date.now() - new Date(createdAt ?? 0).getTime();
  if (age > EDIT_WINDOW_HOURS * 3600_000) {
    return {
      ok: false,
      reason: `Entries can be corrected for ${EDIT_WINDOW_HOURS} hours. `
        + 'After that a manager has to change it, so the record stays trustworthy.',
    };
  }
  return { ok: true };
}
