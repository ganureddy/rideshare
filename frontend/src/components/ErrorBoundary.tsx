// App-wide error boundary.
//
// React Native preview/release builds collapse uncaught render errors
// silently — the JS bridge dies, the UI freezes for a moment and the
// app closes.  No red error screen, no logcat hint visible to the
// user.  That's exactly what's been happening with "the app just
// closes" reports.
//
// This boundary catches any throw from a child render or a child
// lifecycle hook, prints it to a friendly screen the user can read,
// and offers a "Try again" button that resets the boundary state
// (re-mounts the children).  Crucially, the *navigator* stays alive
// underneath, so the user can still get back to the home screen even
// if a single screen blew up.
//
// Pair this with the screen-level boundaries we wrap each tab in
// (RootNavigator) so a crash on, say, RideDetail doesn't take down
// the whole app — just that screen.

import React from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { colors, radii, spacing } from "@/theme";

type Props = {
  children: React.ReactNode;
  /** Optional label shown above the error so we can tell which boundary caught it. */
  label?: string;
};

type State = {
  error: Error | null;
  /** Bumping this key remounts children — used by the "Try again" button. */
  resetKey: number;
};

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, resetKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Log to console so Metro / Logcat / EAS build logs capture it.
    // We deliberately don't ship a remote-error reporter in this MVP.
    // If you wire Sentry later, post `error` + `info.componentStack` here.
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", this.props.label || "(root)", error, info?.componentStack);
  }

  reset = () => {
    this.setState((s) => ({ error: null, resetKey: s.resetKey + 1 }));
  };

  render() {
    const { error, resetKey } = this.state;
    if (!error) {
      // Re-key children on reset so any latent bad state inside them is
      // wiped (re-runs effects, re-fetches, fresh refs).
      return <React.Fragment key={resetKey}>{this.props.children}</React.Fragment>;
    }

    const stack = (error.stack || "").split("\n").slice(0, 12).join("\n");
    return (
      <View style={s.shell}>
        <ScrollView contentContainerStyle={s.body}>
          <View style={s.iconWrap}>
            <Ionicons name="warning" size={36} color={colors.warn} />
          </View>
          <Text style={s.title}>Something went wrong</Text>
          {this.props.label ? (
            <Text style={s.where}>in {this.props.label}</Text>
          ) : null}
          <Text style={s.subtitle}>
            The screen hit an error before it could finish loading. Tap
            "Try again" to retry, or go back and try another action.
          </Text>

          <View style={s.errCard}>
            <Text style={s.errMessage} selectable>
              {error.name}: {error.message}
            </Text>
            {stack ? (
              <Text style={s.errStack} selectable>
                {stack}
              </Text>
            ) : null}
          </View>

          <TouchableOpacity style={s.btn} onPress={this.reset} activeOpacity={0.85}>
            <Ionicons name="refresh" size={16} color={colors.primaryText} />
            <Text style={s.btnText}>Try again</Text>
          </TouchableOpacity>

          <Text style={s.platform}>
            Build: {Platform.OS} · React Native runtime
          </Text>
        </ScrollView>
      </View>
    );
  }
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg },
  body: {
    padding: spacing(5),
    paddingTop: spacing(8),
    alignItems: "stretch"
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#FFF7E0",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    marginBottom: spacing(4)
  },
  title: {
    fontSize: 20,
    fontWeight: "800",
    color: colors.text,
    textAlign: "center",
    letterSpacing: -0.3
  },
  where: {
    fontSize: 12,
    color: colors.soft,
    textAlign: "center",
    marginTop: 4,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.4
  },
  subtitle: {
    fontSize: 14,
    color: colors.soft,
    textAlign: "center",
    marginTop: spacing(2),
    lineHeight: 20
  },
  errCard: {
    marginTop: spacing(5),
    backgroundColor: "#FDECEA",
    borderColor: "#F8C8C2",
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing(3)
  },
  errMessage: {
    color: "#7A1F1A",
    fontSize: 13,
    fontWeight: "700",
    fontFamily: Platform.select({ android: "monospace", ios: "Menlo" })
  },
  errStack: {
    color: "#7A1F1A",
    fontSize: 11,
    marginTop: spacing(2),
    lineHeight: 16,
    fontFamily: Platform.select({ android: "monospace", ios: "Menlo" })
  },
  btn: {
    marginTop: spacing(5),
    backgroundColor: colors.text,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    borderRadius: radii.md
  },
  btnText: {
    color: colors.primaryText,
    fontSize: 15,
    fontWeight: "700"
  },
  platform: {
    marginTop: spacing(4),
    color: colors.mute,
    fontSize: 11,
    textAlign: "center"
  }
});
