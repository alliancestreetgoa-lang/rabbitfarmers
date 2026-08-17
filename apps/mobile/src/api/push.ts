import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import type { ApiClient } from './client.ts';

/**
 * Asking the phone if it will accept notifications, and telling the farm.
 *
 * Every part of this is allowed to fail and none of it is allowed to break the
 * app. A farmer who says no to the permission prompt, an Expo Go session, a
 * browser without a push service, a simulator with no push support — all of
 * them end here returning null, and the app carries on exactly as it did
 * before, showing the same reminders on Today.
 *
 * That is the whole design rule: push is an improvement on opening the app, not
 * a replacement for it. The moment it becomes load-bearing, every farmer whose
 * phone silently revoked the permission stops being told about a kindling.
 */

/** The token this device last registered, so signing out can withdraw it. */
let current: string | null = null;

export function currentPushToken(): string | null {
  return current;
}

/**
 * Register this phone for the farm's reminders.
 *
 * Returns the token on success, or null for every reason it might not work —
 * and the reasons are worth being specific about in the logs, because "push
 * does not arrive" is otherwise unanswerable from a farm.
 */
export async function registerForPush(client: ApiClient): Promise<string | null> {
  try {
    // A browser tab is not a phone. The web build shows reminders on Today, and
    // web push needs a service worker and VAPID keys that do not exist yet.
    if (Platform.OS === 'web') return null;

    let { status, canAskAgain } = await Notifications.getPermissionsAsync();
    if (status !== 'granted' && canAskAgain) {
      ({ status } = await Notifications.requestPermissionsAsync());
    }
    // Asked and refused. Never ask again from here — the OS settings are the
    // only honest place to change this, and a farm hand who said no once should
    // not be nagged every launch.
    if (status !== 'granted') return null;

    /*
     * Two channels, so Android's own settings can separate them.
     *
     * A farmer who mutes the app because of one 6am rebreed reminder loses the
     * loose-motion alerts too. Splitting them means they can silence the
     * routine work and keep the emergencies — which is the difference between
     * a muted app and a tuned one.
     */
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Daily work',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
      await Notifications.setNotificationChannelAsync('urgent', {
        name: 'Sick rabbits',
        importance: Notifications.AndroidImportance.MAX,
        sound: 'default',
      });
    }

    // EAS builds carry a projectId; a bare `expo start` does not, and asking
    // for a token without one throws rather than returning empty.
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } })
      ?.eas?.projectId;
    const { data } = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined);
    if (!data) return null;

    await client.registerDevice({
      token: data,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      device_name: Constants.deviceName ?? undefined,
    });
    current = data;
    return data;
  } catch {
    // Simulator, Expo Go without a project, a network blip during registration.
    // None of it is worth a screen: the reminders are still on Today.
    return null;
  }
}

/**
 * Withdraw this phone on sign-out.
 *
 * A farm hand handing the phone back must stop receiving the farm's reminders
 * on it — and that is a thing the *server* has to be told, because the token
 * keeps working until somebody deletes it.
 */
export async function unregisterPush(client: ApiClient): Promise<void> {
  if (!current) return;
  try {
    await client.unregisterDevice(current);
  } catch {
    /*
     * Best effort, deliberately, and the same call the outbox would make. If it
     * fails the phone keeps getting that farm's reminders until the token is
     * retired — unpleasant, but the alternative is refusing to sign somebody
     * out because the network is down, which is worse.
     */
  }
  current = null;
}
