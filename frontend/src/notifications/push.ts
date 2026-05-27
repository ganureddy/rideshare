// Expo push notifications.
//
// Wires the device's Expo push token into the backend
// (rideshare.api.push.register_push_token) and provides a small helper
// for the navigation layer to deep-link into the right screen when the
// user taps a notification.
//
// All runtime calls swallow errors — push is "best effort" and must
// never crash the app or block sign-in.

import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { call } from "@/api/client";
import { colors } from "@/theme";

let _registered = false;
let _lastUser: string | null = null;

// Foreground behaviour — show a banner + play a sound + bump the badge
// even while the app is open.  WhatsApp-style.
//
// This call runs at *module load time*, so if the native side of
// expo-notifications is missing / mis-bridged on a device, an
// unwrapped throw here would kill the JS bundle before App.tsx even
// renders.  Wrap defensively so a busted notifications module degrades
// to "no foreground banner" instead of "the app won't open".
try {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true
    })
  });
} catch {
  /* noop — best-effort */
}

/**
 * Define Android notification channels for each push category.  iOS
 * doesn't use channels but a no-op call is harmless.  Channels exist so
 * the user can mute "marketing" without losing chat alerts.
 */
async function ensureAndroidChannels(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.setNotificationChannelAsync("default", {
      name: "General",
      importance: Notifications.AndroidImportance.DEFAULT,
      lightColor: colors.brand
    });
    await Notifications.setNotificationChannelAsync("chat", {
      name: "Messages",
      description: "New chat messages from your driver, passenger or support.",
      importance: Notifications.AndroidImportance.MAX,
      sound: "default",
      vibrationPattern: [0, 250, 250, 250],
      lightColor: colors.brand
    });
    await Notifications.setNotificationChannelAsync("bookings", {
      name: "Bookings",
      description: "Booking requests, confirmations and cancellations.",
      importance: Notifications.AndroidImportance.HIGH,
      sound: "default",
      lightColor: colors.brand
    });
    await Notifications.setNotificationChannelAsync("trip", {
      name: "Trip updates",
      description: "Driver started or completed your ride.",
      importance: Notifications.AndroidImportance.HIGH,
      sound: "default",
      lightColor: colors.brand
    });
  } catch {
    /* channel creation is best-effort */
  }
}

/**
 * Get a fresh Expo push token (or null when unsupported / denied).
 * Returns the same token across calls within a process — Expo caches it
 * internally based on the projectId.
 */
export async function getExpoPushToken(): Promise<string | null> {
  // Skip simulators / web — Expo push is device-only.
  if (!Device.isDevice) return null;

  // Expo Go (SDK 53+) on Android no longer supports remote push tokens
  // and logs a noisy warning when `getExpoPushTokenAsync` is called.
  // Local notification handling + channels still work, so we keep the
  // rest of this module alive — just skip the token round-trip when
  // running inside Expo Go.  EAS development / preview / production
  // builds report `executionEnvironment === "standalone"` and still
  // register tokens normally.
  if (Constants.executionEnvironment === "storeClient") return null;

  await ensureAndroidChannels();

  try {
    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;
    if (!granted && existing.canAskAgain !== false) {
      const next = await Notifications.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowBadge: true,
          allowSound: true,
          provideAppNotificationSettings: true
        }
      });
      granted = next.granted;
    }
    if (!granted) return null;

    const projectId =
      (Constants.expoConfig?.extra as any)?.eas?.projectId ||
      (Constants as any).easConfig?.projectId;
    const token = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : ({} as any)
    );
    return token?.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Acquire the push token for the current device and persist it on the
 * server.  Idempotent per (user, token); safe to call on every app launch.
 */
export async function registerPushTokenForUser(user: string): Promise<void> {
  if (_registered && _lastUser === user) return;
  const token = await getExpoPushToken();
  if (!token) return;

  try {
    await call("rideshare.api.push.register_push_token", {
      token,
      platform: Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web",
      app_version:
        (Constants.expoConfig?.version as string | undefined) ||
        ((Constants as any).manifest?.version as string | undefined) ||
        "0.0.0"
    });
    _registered = true;
    _lastUser = user;
  } catch {
    /* network blip — we'll retry on next launch */
  }
}

/**
 * Best-effort logout cleanup.  Tells the server to stop pushing to this
 * device.  Token may have rotated since registration; we just send the
 * latest one.
 */
export async function unregisterPushTokenForUser(): Promise<void> {
  try {
    const token = await getExpoPushToken();
    if (!token) return;
    await call("rideshare.api.push.unregister_push_token", { token });
  } catch {
    /* ignore */
  } finally {
    _registered = false;
    _lastUser = null;
  }
}

// ---------------------------------------------------------------------------
// Tap handling — App.tsx wires `onPushTap` into the React Navigation ref
// so chat / booking / trip notifications deep-link into the right screen.
// ---------------------------------------------------------------------------

export type PushPayload = {
  type?: "chat" | "booking" | "trip" | string;
  thread?: string;
  ride?: string;
  booking?: string;
  event?: string;
  status?: string;
};

export function attachNotificationHandlers(opts: {
  /** Navigation hook called whenever the user taps a notification. */
  onTap: (payload: PushPayload) => void;
  /** Optional: called on every foreground notification (e.g. for an in-app toast). */
  onForeground?: (payload: PushPayload, title?: string, body?: string) => void;
}): () => void {
  // Listener registration can throw on devices where the native
  // notifications module is broken or missing.  Don't let that take
  // down App.tsx — fall back to a no-op cleanup.
  let tapSub: { remove: () => void } | null = null;
  let fgSub: { remove: () => void } | null = null;
  try {
    tapSub = Notifications.addNotificationResponseReceivedListener((response) => {
      try {
        const data = (response.notification.request.content.data || {}) as PushPayload;
        opts.onTap(data);
      } catch {/* ignore tap-handler errors */}
    });
  } catch {/* registration failed — push taps just won't fire */}

  if (opts.onForeground) {
    try {
      fgSub = Notifications.addNotificationReceivedListener((notif) => {
        try {
          const c = notif.request.content;
          opts.onForeground!(
            (c.data || {}) as PushPayload,
            c.title || undefined,
            c.body || undefined
          );
        } catch {/* ignore */}
      });
    } catch {/* registration failed */}
  }

  return () => {
    try { tapSub?.remove(); } catch {/* noop */}
    try { fgSub?.remove(); } catch {/* noop */}
  };
}

/** Resolve a notification tap to a navigation intent. */
export function navIntentFor(
  payload: PushPayload
): { route: string; params: Record<string, unknown> } | null {
  if (!payload || !payload.type) return null;
  if (payload.type === "chat" && payload.thread) {
    return { route: "ChatThread", params: { threadId: payload.thread } };
  }
  if (payload.type === "booking" && payload.ride) {
    return { route: "RideDetail", params: { rideId: payload.ride } };
  }
  if (payload.type === "trip" && payload.ride) {
    return {
      route: "Tracking",
      params: { rideId: payload.ride, role: "passenger" }
    };
  }
  return null;
}
