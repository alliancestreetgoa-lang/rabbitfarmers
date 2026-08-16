import { Platform } from 'react-native';

/**
 * Built for a shed, not a desk.
 *
 * High contrast because the phone is held in Goa sunlight; large tap targets
 * because hands are cold, wet or gloved; a green-biased neutral rather than a
 * pure grey so the palette reads as chosen.
 */
export const colors = {
  ground: '#F6F8F4',
  surface: '#FFFFFF',
  surfaceAlt: '#EDF1EA',
  ink: '#1B211D',
  inkSoft: '#4A554D',
  muted: '#6E7A72',
  rule: '#D3DBD2',
  ruleStrong: '#B6C1B5',
  accent: '#2C5F53',
  accentSoft: '#DCE9E3',
  warn: '#8A6510',
  warnSoft: '#F5EBD3',
  crit: '#8C332B',
  critSoft: '#F5DFDC',
  /** The loose-motion mark. Always drawn with the words beside it. */
  condition: '#EA580C',
  white: '#FFFFFF',
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const radius = { sm: 4, md: 8, lg: 12 } as const;

/**
 * 48pt minimum on anything tappable. Below that, a farm hand with wet hands
 * misses, and one mis-tap that records the wrong thing costs more trust than
 * the whole screen earns.
 */
export const TAP_MIN = 48;

export const type = {
  display: {
    fontFamily: Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia, serif' }),
  },
  h1: { fontSize: 28, lineHeight: 34, fontWeight: '400' as const },
  h2: { fontSize: 21, lineHeight: 27, fontWeight: '400' as const },
  title: { fontSize: 17, lineHeight: 23, fontWeight: '600' as const },
  body: { fontSize: 16, lineHeight: 23, fontWeight: '400' as const },
  small: { fontSize: 14, lineHeight: 20, fontWeight: '400' as const },
  label: {
    fontSize: 11, lineHeight: 14, fontWeight: '600' as const, letterSpacing: 1.2,
  },
  number: { fontSize: 40, lineHeight: 44, fontWeight: '400' as const },
} as const;

export const urgencyColor = (u: string) => {
  if (u === 'critical') return { fg: colors.crit, bg: colors.critSoft };
  if (u === 'high') return { fg: colors.warn, bg: colors.warnSoft };
  return { fg: colors.accent, bg: colors.accentSoft };
};

/** "in 3 days", "2 days ago", "today" — how a farmer actually thinks about it. */
export function relativeDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const today = new Date();
  const then = new Date(iso.slice(0, 10) + 'T00:00:00Z');
  const days = Math.round(
    (Date.UTC(then.getUTCFullYear(), then.getUTCMonth(), then.getUTCDate())
      - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
    / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days < 0) return `${-days} days ago`;
  return `in ${days} days`;
}

export const STATE_LABEL: Record<string, string> = {
  GROWING: 'Growing',
  READY: 'Ready to mate',
  MATED: 'Awaiting check',
  PREGNANT: 'Pregnant',
  NEST_BOX: 'Due — nest box in',
  LACTATING: 'Nursing',
  PSEUDOPREGNANT: 'False pregnancy',
  OPEN: 'Resting',
  RESTING: 'Resting',
  OVERDUE: 'Overdue',
};
