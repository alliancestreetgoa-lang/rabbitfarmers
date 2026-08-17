/**
 * Where the API lives.
 *
 * This is four lines of logic that decide whether the app can talk to anything
 * at all, and getting it wrong is invisible: the app builds, installs, opens,
 * and every screen says "no connection". It lives in its own module, taking its
 * inputs as arguments rather than reaching for globals, so it can be tested
 * without a React Native runtime — which is the only reason any of it is
 * checked at all.
 *
 * The caller reads the globals. In particular `process.env.EXPO_PUBLIC_API_URL`
 * has to be written out literally at the call site: Metro substitutes the value
 * by matching that exact expression while it builds the bundle, and any
 * indirection reads back undefined.
 */

/** Trailing slashes are what a person typing a URL produces. `${base}/health`
 *  with one left on is a 404 nobody can diagnose from the screen. */
export const trimUrl = (u: string) => u.trim().replace(/\/+$/, '');

/** A bare Node process in tests, with nothing configured. */
export const DEV_FALLBACK = 'http://localhost:3000';

export interface ServerUrlSources {
  /**
   * `process.env.EXPO_PUBLIC_API_URL` — substituted into the JavaScript by
   * Metro at build time, so it travels *inside the bundle*. This is what makes
   * an APK independent of how its native half was configured.
   */
  fromBundle?: string | null;
  /**
   * `Constants.expoConfig.extra.apiUrl`. Does **not** travel in the bundle on
   * native: it comes from an app.config embedded during the native build, which
   * on EAS happens on Expo's machines and only carries a value if eas.json's
   * `env` had one. It is what `expo start` and the web build read.
   */
  fromConfig?: string | null;
  /** What the farmer typed on the sign-in screen, read back from storage. */
  stored?: string | null;
  /** `window.location.origin`, when there is a window. */
  origin?: string | null;
}

// `.+` matters: "https://" on its own passes a bare scheme check, and then
// trimUrl strips the slashes that belong to the scheme and leaves "https:".
const absolute = (v: string | null | undefined) =>
  v && /^https?:\/\/.+/i.test(v.trim()) ? trimUrl(v) : null;

/**
 * Compiled in at build time, from either source. An absolute URL wins outright
 * — it is how a native build finds its server, and how a developer points a web
 * build at localhost.
 */
export function bakedApiUrl(s: ServerUrlSources): string | null {
  return absolute(s.fromBundle) ?? absolute(s.fromConfig);
}

/**
 * The origin that served the page, if any. Netlify puts the app and the
 * function on one site, so `/api` here is the same deploy — which is why one
 * web build works on a preview, a branch deploy and production without being
 * told which it is.
 */
export function sameOriginApiUrl(s: ServerUrlSources): string | null {
  return s.origin ? `${trimUrl(s.origin)}/api` : null;
}

/** Baked in, then typed in, then the page's own origin, then the dev server. */
export function resolveApiUrl(s: ServerUrlSources): string {
  return bakedApiUrl(s)
    ?? absolute(s.stored)
    ?? sameOriginApiUrl(s)
    ?? DEV_FALLBACK;
}

/**
 * An installed app has no origin to fall back on.
 *
 * A web build can work the address out for itself. An APK cannot: it is a file
 * on a phone, and unless the address was compiled into it there is nothing to
 * ask. Left unhandled that is an app which installs, opens, and silently fails
 * every request — the worst possible first five minutes.
 */
export function needsServerAddress(s: ServerUrlSources): boolean {
  return bakedApiUrl(s) === null && sameOriginApiUrl(s) === null;
}

/**
 * Check an address a person typed, before anything is stored.
 *
 * Returns the cleaned-up URL, or throws with something a farmer reading a URL
 * off a piece of paper can act on.
 */
export function validateServerUrl(input: string): string {
  // Whitespace off first, but trailing slashes left ON until the end: stripping
  // them before the scheme is checked turns "https://" into "https:", and the
  // farmer gets told to start the address with the thing they did start it with.
  const raw = (input ?? '').trim();
  if (!raw) throw new Error('Type the address of your Rabbitry site');

  if (!/^https?:\/\//i.test(raw)) {
    throw new Error('That should start with https:// and be the address of your Rabbitry site');
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a web address`);
  }
  if (!parsed.hostname) throw new Error(`"${raw}" is missing the site name`);

  return trimUrl(raw);
}
