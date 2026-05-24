import "react-native-gesture-handler";
import React, { useEffect, useRef } from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  NavigationContainer,
  NavigationContainerRef
} from "@react-navigation/native";
import * as Linking from "expo-linking";
import { AuthProvider, useAuth } from "@/auth/AuthContext";
import { RootNavigator, RootStackParamList } from "@/navigation/RootNavigator";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import {
  attachNotificationHandlers,
  navIntentFor,
  registerPushTokenForUser
} from "@/notifications/push";

// Last-resort guard for unhandled promise rejections (a common cause of
// silent app closures on Android release builds).  We log the error to
// the console — the ErrorBoundary further down handles render errors
// the React way.
if (typeof globalThis !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (typeof g.HermesInternal !== "undefined" || typeof g.process !== "undefined") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const tracking = require("promise/setimmediate/rejection-tracking");
      tracking.enable({
        allRejections: true,
        onUnhandled: (id: number, error: unknown) => {
          // eslint-disable-next-line no-console
          console.error("[unhandledRejection]", id, error);
        },
        onHandled: () => {/* noop */}
      });
    } catch {/* runtime doesn't expose the polyfill — fine */}
  }
}

const linking = {
  prefixes: [Linking.createURL("/"), "rideshare://"],
  config: {
    screens: {
      Login: "auth",
      Home: "home",
      RideDetail: "ride/:rideId",
      Tracking: "track/:rideId"
    }
  }
};

function Root() {
  const { ready, user } = useAuth();
  const navRef = useRef<NavigationContainerRef<RootStackParamList>>(null);
  const pendingPushRef = useRef<{ route: string; params: Record<string, unknown> } | null>(
    null
  );

  // Once we know who's signed in, hand the device token to the backend so
  // pushes start landing.  Logging out and back in re-runs this with the
  // new user; the helper is idempotent.
  useEffect(() => {
    if (!ready || !user) return;
    registerPushTokenForUser(user);
  }, [ready, user]);

  // Notification tap handler — deep-link into the right screen.  When the
  // app is cold-started by a tap, the navigator may not exist yet; we
  // stash the intent and replay it on the next render where it's ready.
  useEffect(() => {
    function deliver(intent: { route: string; params: Record<string, unknown> }) {
      const nav = navRef.current as any;
      if (!nav?.isReady?.()) {
        pendingPushRef.current = intent;
        return;
      }
      nav.navigate(intent.route, intent.params);
    }
    const unsub = attachNotificationHandlers({
      onTap: (payload) => {
        const intent = navIntentFor(payload);
        if (intent) deliver(intent);
      }
    });
    return unsub;
  }, []);

  if (!ready) return null; // Splash will be shown by Expo until first render
  return (
    <NavigationContainer
      ref={navRef}
      linking={linking}
      onReady={() => {
        const pending = pendingPushRef.current;
        if (pending) {
          pendingPushRef.current = null;
          (navRef.current as any)?.navigate(pending.route, pending.params);
        }
      }}
    >
      <RootNavigator />
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <ErrorBoundary label="App root">
      <SafeAreaProvider>
        <AuthProvider>
          <StatusBar style="dark" backgroundColor="#FFFFFF" />
          <Root />
        </AuthProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}
