import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  ActivityIndicator
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import Ionicons from "@expo/vector-icons/Ionicons";
import { call } from "@/api/client";
import { colors, radii, spacing, shadow } from "@/theme";
import { fmtDateTime } from "@/utils/dateUtils";
import type { RootStackParamList } from "@/navigation/RootNavigator";

type Nav = NativeStackNavigationProp<RootStackParamList>;

export type ChatListItem = {
  name: string;
  thread_type: "Booking" | "Support";
  subject: string;
  status: string;
  booking?: string;
  ride?: string;
  driver?: string;
  passenger?: string;
  last_message?: string;
  last_message_at?: string;
  last_sender?: string;
  unread: number;
  counterparty: { label: string; kind: string; user?: string };
};

export function ChatListScreen() {
  const nav = useNavigation<Nav>();
  const [items, setItems] = useState<ChatListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await call<ChatListItem[]>("rideshare.api.chat.list_threads", {
        limit: 100
      });
      setItems(Array.isArray(res) ? res : []);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load();
    }, [load])
  );

  return (
    <SafeAreaView style={s.shell} edges={["top"]}>
      <View style={s.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={s.h1}>Chats</Text>
          <Text style={s.sub}>Talk to your drivers and riders. Need help? Find Helpline in Account.</Text>
        </View>
      </View>

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator color={colors.text} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it) => it.name}
          contentContainerStyle={{ padding: spacing(4), gap: spacing(3) }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />
          }
          ListEmptyComponent={
            <View style={s.empty}>
              <Ionicons name="chatbubbles-outline" size={42} color={colors.mute} />
              <Text style={s.emptyTitle}>No chats yet</Text>
              <Text style={s.emptyText}>
                Book a ride and you can chat directly with the driver here.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[s.card, shadow.card]}
              onPress={() => nav.navigate("ChatThread" as any, { threadId: item.name })}
              activeOpacity={0.85}
            >
              <View style={[s.avatar, item.thread_type === "Support" && s.avatarSupport]}>
                {item.thread_type === "Support" ? (
                  <Ionicons name="help-buoy" size={20} color={colors.primaryText} />
                ) : (
                  <Text style={s.avatarText}>
                    {(item.counterparty?.label || "?")
                      .split(/\s+/)
                      .filter(Boolean)
                      .map((p) => p[0] || "")
                      .slice(0, 2)
                      .join("")
                      .toUpperCase() || "?"}
                  </Text>
                )}
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <View style={s.row}>
                  <Text style={s.title} numberOfLines={1}>
                    {item.thread_type === "Support"
                      ? "Rideshare Support"
                      : (item.counterparty?.label || "Conversation")}
                  </Text>
                  {item.last_message_at ? (
                    <Text style={s.time}>{fmtDateTime(item.last_message_at)}</Text>
                  ) : null}
                </View>
                <Text style={s.preview} numberOfLines={1}>
                  {item.last_message || item.subject || "—"}
                </Text>
              </View>
              {item.unread > 0 ? (
                <View style={s.badge}>
                  <Text style={s.badgeText}>{item.unread > 99 ? "99+" : item.unread}</Text>
                </View>
              ) : null}
            </TouchableOpacity>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: spacing(4),
    paddingTop: spacing(2),
    paddingBottom: spacing(2),
    gap: 12
  },
  h1: { fontSize: 26, fontWeight: "800", color: colors.text, letterSpacing: -0.4 },
  sub: { fontSize: 13, color: colors.soft, marginTop: 2 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    padding: spacing(3),
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 12
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.text,
    alignItems: "center",
    justifyContent: "center"
  },
  avatarSupport: { backgroundColor: colors.warn },
  avatarText: { color: colors.primaryText, fontWeight: "800", fontSize: 14 },

  row: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  title: { fontSize: 15, fontWeight: "700", color: colors.text, flex: 1 },
  time: { fontSize: 11, color: colors.soft },
  preview: { fontSize: 13, color: colors.soft },

  badge: {
    backgroundColor: colors.danger,
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center"
  },
  badgeText: { color: "#fff", fontSize: 11, fontWeight: "800" },

  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  empty: { alignItems: "center", padding: spacing(8), gap: 6 },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: "700", marginTop: 6 },
  emptyText: { color: colors.soft, fontSize: 13, textAlign: "center", lineHeight: 19 }
});
