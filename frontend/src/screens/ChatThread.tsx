// Realtime chat for the mobile app — implemented as a thin shell over a
// Jinja page (rideshare/www/rideshare/m/chat.html) loaded inside a
// `react-native-webview`.  The page itself owns the chat UX: it
// connects directly to Frappe's built-in Socket.IO bridge
// (frappe.publish_realtime → rideshare:chat:message + :typing), renders
// messages as they arrive, and POSTs new ones back through
// `rideshare.api.chat.send_message`.
//
// The native shell is intentionally tiny: a back button, a status header
// and a WebView.  Pull-to-refresh remounts the page so dropped sockets
// can reconnect without leaving the screen.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
  BackHandler,
  Linking
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute, RouteProp, useFocusEffect } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { WebView } from "react-native-webview";
import { chatWebSource } from "@/auth/AuthContext";
import { colors, spacing } from "@/theme";
import type { RootStackParamList } from "@/navigation/RootNavigator";

type Route = RouteProp<RootStackParamList, "ChatThread">;

export function ChatThreadScreen() {
  const { params } = useRoute<Route>();
  const nav = useNavigation();
  const webRef = useRef<WebView | null>(null);

  const [source, setSource] = useState<{ uri: string; headers: Record<string, string> } | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const buildSource = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const src = await chatWebSource(params.threadId);
      setSource(src);
    } catch (e: any) {
      setError(e?.message ?? "Couldn't open chat.");
      setLoading(false);
    }
  }, [params.threadId]);

  useEffect(() => {
    buildSource();
  }, [buildSource, reloadKey]);

  // Capture Android hardware back so it goes back through the navigator
  // instead of trying to pop within the WebView history stack.
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        nav.goBack();
        return true;
      });
      return () => sub.remove();
    }, [nav])
  );

  function onMessage(e: { nativeEvent: { data: string } }) {
    try {
      const data = JSON.parse(e.nativeEvent.data);
      if (data?.type === "back") nav.goBack();
      if (data?.type === "ready") setLoading(false);
    } catch {/* ignore */}
  }

  return (
    <SafeAreaView style={s.shell} edges={["top"]}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => nav.goBack()} hitSlop={12}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.title} numberOfLines={1}>Conversation</Text>
          <Text style={s.subtitle} numberOfLines={1}>
            Realtime · Frappe Socket.IO
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => setReloadKey((k) => k + 1)}
          style={s.reloadBtn}
          hitSlop={6}
          activeOpacity={0.85}
        >
          <Ionicons name="refresh" size={18} color={colors.text} />
        </TouchableOpacity>
      </View>

      {error ? (
        <View style={s.center}>
          <Ionicons name="warning-outline" size={28} color={colors.warn} />
          <Text style={s.errText}>{error}</Text>
          <TouchableOpacity
            onPress={() => setReloadKey((k) => k + 1)}
            style={s.retryBtn}
            activeOpacity={0.85}
          >
            <Text style={s.retryText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : !source ? (
        <View style={s.center}>
          <ActivityIndicator color={colors.text} />
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          <WebView
            key={reloadKey}
            ref={(r) => {
              webRef.current = r;
            }}
            source={source}
            style={{ flex: 1, backgroundColor: colors.bg }}
            originWhitelist={["*"]}
            javaScriptEnabled
            domStorageEnabled
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            allowsInlineMediaPlayback
            setSupportMultipleWindows={false}
            onMessage={onMessage}
            onLoadStart={() => setLoading(true)}
            onLoadEnd={() => setLoading(false)}
            onError={(e) => {
              setLoading(false);
              setError(e.nativeEvent.description || "Couldn't load chat.");
            }}
            onHttpError={(e) => {
              setLoading(false);
              const code = e.nativeEvent.statusCode;
              setError(`Chat server returned HTTP ${code}.`);
            }}
            onShouldStartLoadWithRequest={(req) => {
              // Phone-call links shouldn't be loaded inside the WebView —
              // hand them to the OS dialler.
              if (req.url.startsWith("tel:")) {
                Alert.alert("Open dialler?", req.url.slice(4), [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Call",
                    onPress: () => {
                      Linking.openURL(req.url).catch(() => {});
                    }
                  }
                ]);
                return false;
              }
              return true;
            }}
          />
          {loading ? (
            <View style={s.overlay} pointerEvents="none">
              <ActivityIndicator color={colors.text} />
            </View>
          ) : null}
        </View>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(2),
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card
  },
  title: { fontSize: 16, fontWeight: "800", color: colors.text, letterSpacing: -0.2 },
  subtitle: { fontSize: 11, color: colors.soft, marginTop: 2 },
  reloadBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bgAlt,
    borderWidth: 1,
    borderColor: colors.border
  },

  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    padding: 24
  },
  errText: { color: colors.text, fontSize: 14, textAlign: "center" },
  retryBtn: {
    marginTop: 6,
    backgroundColor: colors.text,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999
  },
  retryText: { color: colors.primaryText, fontWeight: "800", fontSize: 13 },

  overlay: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(255,255,255,0.6)",
    alignItems: "center",
    justifyContent: "center"
  }
});
