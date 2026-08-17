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
    icon: './assets/icon.png',
    // Drawn by scripts/make-icons.mjs — a script, not four checked-in binaries,
    // because an icon is the one asset nobody can read a diff of.
    splash: {
      image: './assets/splash.png',
      backgroundColor: '#2C5F53',
      resizeMode: 'contain',
    },
    android: {
      package: 'in.rabbitry.app',
      // Bump on every build uploaded anywhere. Play refuses a repeat, and two
      // different APKs sharing a versionCode is how a phone ends up refusing an
      // update with no useful message.
      versionCode: 1,
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#2C5F53',
      },
      // Only this one. Everything the app does is an HTTPS call — no camera, no
      // location, no contacts — and an app that asks for nothing else is an
      // easier thing to hand to a farm hand's phone.
      permissions: ['INTERNET'],
    },
    ios: {
      supportsTablet: false,
      bundleIdentifier: 'in.rabbitry.app',
      buildNumber: '1',
    },
    web: {
      bundler: 'metro',
      output: 'single',
      favicon: './assets/favicon.png',
    },
    plugins: ['expo-router'],
    extra: {
      /*
       * Empty means "same origin as the page", which is what a Netlify deploy
       * wants — one build works on a preview, a branch deploy and production.
       *
       * A native build has no origin to fall back on. Set this at build time
       * for an APK handed to farmers:
       *
       *   EXPO_PUBLIC_API_URL=https://yourfarm.netlify.app/api eas build …
       *
       * A build without it is not broken: the sign-in screen asks for the
       * address once and remembers it. See resolveApiUrl in src/state.tsx.
       */
      apiUrl: process.env.EXPO_PUBLIC_API_URL ?? '',
      // `eas init` writes a projectId in here. It is account-specific, so it is
      // deliberately not committed with one.
      eas: process.env.EAS_PROJECT_ID ? { projectId: process.env.EAS_PROJECT_ID } : undefined,
    },
  },
};
