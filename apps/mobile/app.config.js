/**
 * Expo config as code, rather than app.json, for one reason: the API URL has to
 * come from the environment.
 *
 * A hard-coded http://localhost:3000 in app.json is invisible in development —
 * everything works — and then ships a production web build that talks to the
 * farmer's own laptop. Reading it from the environment means the Netlify build
 * cannot accidentally inherit a developer's setting.
 */
module.exports = {
  expo: {
    name: 'Rabbitry',
    slug: 'rabbitry',
    version: '0.1.0',
    orientation: 'portrait',
    scheme: 'rabbitry',
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,
    splash: {
      backgroundColor: '#2C5F53',
      resizeMode: 'contain',
    },
    android: {
      package: 'in.rabbitry.app',
      adaptiveIcon: { backgroundColor: '#2C5F53' },
    },
    ios: {
      supportsTablet: false,
      bundleIdentifier: 'in.rabbitry.app',
    },
    plugins: ['expo-router'],
    extra: {
      // Empty means "same origin as the page", which is what a Netlify deploy
      // wants. A native build has no origin to fall back on, so it needs this
      // set at build time — see resolveApiUrl in src/state.tsx.
      apiUrl: process.env.EXPO_PUBLIC_API_URL ?? '',
    },
    web: {
      bundler: 'metro',
      output: 'single',
    },
  },
};
