/**
 * Where the app decides to send its requests.
 *
 * Four lines of logic that decide whether the app can talk to anything at all,
 * and every way of getting it wrong is invisible from the screen: the build
 * succeeds, the app installs, opens, and says "no connection" on every tab.
 *
 * Two of these cases are bugs that actually shipped and were caught by grepping
 * a compiled bundle rather than by anything automatic — that is what this file
 * is here to replace. They are marked below.
 *
 * No API and no React Native runtime: the module takes its inputs as arguments
 * precisely so this can be a plain unit test.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEV_FALLBACK, bakedApiUrl, needsServerAddress, resolveApiUrl, sameOriginApiUrl,
  trimUrl, validateServerUrl,
} from '../src/api/server-url.ts';

/** A web build on Netlify: nothing compiled in, served by the site itself. */
const WEB = { fromBundle: '', fromConfig: '', origin: 'https://yourfarm.netlify.app' };
/** An APK built with the address compiled in. The one to hand to farmers. */
const APK_CONFIGURED = {
  fromBundle: 'https://yourfarm.netlify.app/api', fromConfig: '', origin: null,
};
/** An APK built without one. Has to ask. */
const APK_BARE = { fromBundle: '', fromConfig: '', origin: null };

describe('resolving the API address', () => {
  test('a web build talks to the site that served it', () => {
    assert.equal(resolveApiUrl(WEB), 'https://yourfarm.netlify.app/api');
    assert.equal(needsServerAddress(WEB), false, 'the web build must never ask');
  });

  test('a configured APK uses what was compiled in', () => {
    assert.equal(resolveApiUrl(APK_CONFIGURED), 'https://yourfarm.netlify.app/api');
    assert.equal(needsServerAddress(APK_CONFIGURED), false);
  });

  test('a bare APK asks, and keeps the answer', () => {
    assert.equal(needsServerAddress(APK_BARE), true);
    // Before it is told anything it has only the dev fallback, which is
    // useless on a phone — hence the asking.
    assert.equal(resolveApiUrl(APK_BARE), DEV_FALLBACK);

    const told = { ...APK_BARE, stored: 'https://anil.example.farm/api' };
    assert.equal(resolveApiUrl(told), 'https://anil.example.farm/api');
    // Still true: it is a build with no address compiled in, so the field stays
    // on the sign-in screen and a wrong answer can be corrected.
    assert.equal(needsServerAddress(told), true);
  });

  test('the bundle beats the embedded config', () => {
    /*
     * THE BUG THIS EXISTS FOR.
     *
     * `Constants.expoConfig.extra` does not travel in the JavaScript bundle on
     * native — it comes from an app.config embedded during the native half of
     * the build, on Expo's machines, and it is empty unless eas.json's `env`
     * carried the value. Reading only that source produced an APK that ignored
     * the address it was given and asked the farmer instead.
     */
    assert.equal(bakedApiUrl({
      fromBundle: 'https://from-bundle.example/api',
      fromConfig: 'https://from-config.example/api',
    }), 'https://from-bundle.example/api');

    // Either alone is enough — `expo start` and the web build only have the
    // second one.
    assert.equal(bakedApiUrl({ fromConfig: 'https://from-config.example/api' }),
      'https://from-config.example/api');
  });

  test('a compiled-in address beats one typed on the device', () => {
    // An app handed to farmers must not be re-pointable by typing, and the
    // stored value from an earlier build must not override a new one.
    assert.equal(resolveApiUrl({
      ...APK_CONFIGURED, stored: 'https://somewhere-else.example/api',
    }), 'https://yourfarm.netlify.app/api');
  });

  test('empty is not an address', () => {
    /*
     * THE OTHER ONE. Netlify sets EXPO_PUBLIC_API_URL to the empty string on
     * purpose, so that the web build falls through to its own origin. An empty
     * string is falsy but `''.startsWith('http')` and `typeof '' === 'string'`
     * are both easy to get wrong, and treating it as configured pins the app to
     * a base URL of "" — every request goes to the wrong place.
     */
    for (const empty of ['', '   ', null, undefined]) {
      assert.equal(bakedApiUrl({ fromBundle: empty, fromConfig: empty }), null,
        `${JSON.stringify(empty)} must not count as an address`);
    }
    assert.equal(resolveApiUrl({ fromBundle: '', fromConfig: '', origin: 'https://x.test' }),
      'https://x.test/api');
  });

  test('half-typed addresses are not accepted as compiled-in ones', () => {
    for (const junk of ['yourfarm.netlify.app', '/api', 'ftp://x.test', 'httpx://x.test']) {
      assert.equal(bakedApiUrl({ fromBundle: junk }), null, `${junk} is not an http(s) URL`);
    }
  });

  test('trailing slashes are removed everywhere they can appear', () => {
    // `${base}/health` with a slash left on is a 404 that reads, on screen, as
    // "nothing answered" — indistinguishable from a wrong address.
    assert.equal(trimUrl('https://x.test/api///'), 'https://x.test/api');
    assert.equal(bakedApiUrl({ fromBundle: 'https://x.test/api/' }), 'https://x.test/api');
    assert.equal(resolveApiUrl({ stored: 'https://x.test/api/' }), 'https://x.test/api');
    assert.equal(sameOriginApiUrl({ origin: 'https://x.test/' }), 'https://x.test/api');
  });

  test('nothing at all falls back to the dev server', () => {
    // A bare Node process — this test file, among others.
    assert.equal(resolveApiUrl({}), DEV_FALLBACK);
  });
});

describe('checking an address a person typed', () => {
  test('accepts what a farmer would actually be given', () => {
    assert.equal(validateServerUrl('https://yourfarm.netlify.app'),
      'https://yourfarm.netlify.app');
    assert.equal(validateServerUrl('  https://yourfarm.netlify.app/api/  '),
      'https://yourfarm.netlify.app/api');
    // http is allowed: a farm running this on a local machine is a real case.
    assert.equal(validateServerUrl('http://192.168.1.40:3000'), 'http://192.168.1.40:3000');
  });

  test('refuses the rest with something actionable', () => {
    const cases: [string, RegExp][] = [
      ['', /Type the address/],
      ['   ', /Type the address/],
      ['yourfarm.netlify.app', /should start with https/],
      ['www.yourfarm.netlify.app', /should start with https/],
      ['https://', /not a web address|missing the site name/],
    ];
    for (const [input, expected] of cases) {
      assert.throws(() => validateServerUrl(input), expected,
        `"${input}" should be refused`);
    }
  });
});
