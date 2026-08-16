/**
 * Netlify Functions v2 entry point.
 *
 * v2 functions receive a standard `Request` and return a standard `Response`,
 * which is exactly what Hono's `app.fetch` is — so this is a one-line adapter
 * with no translation layer to go wrong.
 *
 * The app is built once at module scope. Netlify reuses a warm instance across
 * invocations, so the pg pools are reused too rather than reconnecting on every
 * request — which matters against Neon, where a cold connection is the slow part.
 */
import { createApp } from '../../apps/api/src/app.js';

const app = createApp();

export default async (request) => app.fetch(request);

// Everything is API and admin console for now; there is no static site yet.
// If a marketing site is added later, narrow this to the API prefixes so
// Netlify serves the static pages itself.
export const config = {
  path: '/*',
  preferStatic: true,
};
