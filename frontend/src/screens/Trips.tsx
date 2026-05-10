import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  FlatList,
  RefreshControl,
  TouchableOpacity,
  StyleSheet
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";
import { call } from "@/api/client";
import { colors, radii, spacing, shadow } from "@/theme";
import type { RootStackParamList } from "@/navigation/RootNavigator";

type Nav = NativeStackNavigationProp<RootStackParamList, "Tabs">;

type Booking = {
  name: string;
  ride: string;
  status: string;
  seats_booked: number;
  total_amount: number;
  origin_city: string;
  destination_city: string;
  departure_datetime: string;
};

type Ride = {
  name: string;
  origin_city: string;
  destination_city: string;
  departure_datetime: string;
  status: string;
  seats_total: number;
  seats_available: number;
  price_per_seat: number;
};

type Dashboard = {
  upcoming_bookings: Booking[];
  upcoming_rides: Ride[];
  active_trip_as_passenger: { booking: string; ride: string } | null;
  active_trip_as_driver: { name: string } | null;
};

type History = {
  past_bookings: Booking[];
  past_rides: Ride[];
};

function fmtDateTime(s: string) {
  try {
    return new Date(s.replace(" ", "T")).toLocaleString([], {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return s;
  }
}

export function TripsScreen() {
  const nav = useNavigation<Nav>();
  const route = useRoute<any>();
  const [data, setData] = useState<Dashboard | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<"upcoming" | "history">("upcoming");

  // Honour `startTab` whenever Profile (or any other caller) deep-links us.
  useEffect(() => {
    const start = route.params?.startTab;
    if (start === "history" || start === "upcoming") {
      setTab(start);
    }
  }, [route.params?.startTab]);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [d, h] = await Promise.all([
        call<Dashboard>("rideshare.api.mobile.home_dashboard"),
        call<History>("rideshare.api.mobile.trip_history", { limit: 50 }).catch(
          () => ({ past_bookings: [], past_rides: [] }) as History
        )
      ]);
      setData(d);
      setHistory(h);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <SafeAreaView style={s.shell} edges={["top"]}>
      <FlatList
        contentContainerStyle={{ padding: spacing(4), paddingBottom: spacing(8) }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} />}
        data={[]}
        renderItem={null as any}
        ListHeaderComponent={
          <>
            <Text style={s.h1}>Your trips</Text>
            <Text style={s.sub}>
              Bookings and rides linked to your number — they stay with you across reinstalls.
            </Text>

            <View style={s.tabRow}>
              <TabButton
                label="Upcoming"
                active={tab === "upcoming"}
                onPress={() => setTab("upcoming")}
              />
              <TabButton
                label="History"
                active={tab === "history"}
                onPress={() => setTab("history")}
              />
            </View>

            {tab === "upcoming" ? (
              <UpcomingTab data={data} nav={nav} />
            ) : (
              <HistoryTab history={history} nav={nav} />
            )}
          </>
        }
      />
    </SafeAreaView>
  );
}

function TabButton({
  label,
  active,
  onPress
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[s.tabBtn, active && s.tabBtnActive]}
      activeOpacity={0.8}
      onPress={onPress}
    >
      <Text style={[s.tabBtnText, active && s.tabBtnTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function UpcomingTab({
  data,
  nav
}: {
  data: Dashboard | null;
  nav: Nav;
}) {
  return (
    <>
      {data?.active_trip_as_passenger ? (
        <TouchableOpacity
          style={[s.activeCard, shadow.floating]}
          activeOpacity={0.85}
          onPress={() =>
            nav.navigate("Tracking", {
              rideId: data.active_trip_as_passenger!.ride,
              role: "passenger"
            })
          }
        >
          <View style={s.activeIcon}>
            <Ionicons name="navigate" size={18} color={colors.primaryText} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.activeTitle}>Trip in progress</Text>
            <Text style={s.activeSub}>Tap to follow your driver on the map.</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.primaryText} />
        </TouchableOpacity>
      ) : null}

      {data?.active_trip_as_driver ? (
        <TouchableOpacity
          style={[s.activeCard, { backgroundColor: colors.warn }, shadow.floating]}
          activeOpacity={0.85}
          onPress={() =>
            nav.navigate("Tracking", {
              rideId: data.active_trip_as_driver!.name,
              role: "driver"
            })
          }
        >
          <View style={s.activeIcon}>
            <Ionicons name="car" size={18} color={colors.primaryText} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.activeTitle}>You're driving</Text>
            <Text style={s.activeSub}>Tap to broadcast your location.</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.primaryText} />
        </TouchableOpacity>
      ) : null}

      <Section title="Upcoming bookings" />
      {(data?.upcoming_bookings || []).map((b) => (
        <TouchableOpacity
          key={b.name}
          style={[s.card, shadow.card]}
          activeOpacity={0.85}
          onPress={() => nav.navigate("RideDetail", { rideId: b.ride })}
        >
          <View style={s.cardHead}>
            <Text style={s.cardRoute} numberOfLines={1}>
              {b.origin_city} → {b.destination_city}
            </Text>
            <StatusChip status={b.status} />
          </View>
          <Text style={s.cardMeta}>
            {fmtDateTime(b.departure_datetime)} · {b.seats_booked} seat
            {b.seats_booked === 1 ? "" : "s"} · ₹{Math.round(b.total_amount)}
          </Text>
        </TouchableOpacity>
      ))}
      {data && data.upcoming_bookings.length === 0 ? (
        <Empty
          icon="ticket-outline"
          title="No upcoming bookings"
          text="Find a ride to get started."
        />
      ) : null}

      <Section title="Rides you're driving" />
      {(data?.upcoming_rides || []).map((r) => (
        <TouchableOpacity
          key={r.name}
          style={[s.card, shadow.card]}
          activeOpacity={0.85}
          onPress={() => nav.navigate("Tracking", { rideId: r.name, role: "driver" })}
        >
          <View style={s.cardHead}>
            <Text style={s.cardRoute} numberOfLines={1}>
              {r.origin_city} → {r.destination_city}
            </Text>
            <StatusChip status={r.status} />
          </View>
          <Text style={s.cardMeta}>
            {fmtDateTime(r.departure_datetime)} · {r.seats_available}/{r.seats_total} seats left · ₹{Math.round(r.price_per_seat)}
          </Text>
        </TouchableOpacity>
      ))}
      {data && data.upcoming_rides.length === 0 ? (
        <Empty
          icon="car-outline"
          title="No rides published"
          text="Publish a ride from the Publish tab."
        />
      ) : null}
    </>
  );
}

function HistoryTab({
  history,
  nav
}: {
  history: History | null;
  nav: Nav;
}) {
  const past = history?.past_bookings || [];
  const drove = history?.past_rides || [];
  return (
    <>
      <Section title="Past bookings" />
      {past.map((b) => (
        <TouchableOpacity
          key={b.name}
          style={[s.card, shadow.card]}
          activeOpacity={0.85}
          onPress={() => nav.navigate("RideDetail", { rideId: b.ride })}
        >
          <View style={s.cardHead}>
            <Text style={s.cardRoute} numberOfLines={1}>
              {b.origin_city} → {b.destination_city}
            </Text>
            <StatusChip status={b.status} />
          </View>
          <Text style={s.cardMeta}>
            {fmtDateTime(b.departure_datetime)} · {b.seats_booked} seat
            {b.seats_booked === 1 ? "" : "s"} · ₹{Math.round(b.total_amount)}
          </Text>
        </TouchableOpacity>
      ))}
      {history && past.length === 0 ? (
        <Empty
          icon="time-outline"
          title="No past bookings"
          text="Once you complete a ride, it'll show up here."
        />
      ) : null}

      <Section title="Past rides driven" />
      {drove.map((r) => (
        <TouchableOpacity
          key={r.name}
          style={[s.card, shadow.card]}
          activeOpacity={0.85}
          onPress={() => nav.navigate("RideDetail", { rideId: r.name })}
        >
          <View style={s.cardHead}>
            <Text style={s.cardRoute} numberOfLines={1}>
              {r.origin_city} → {r.destination_city}
            </Text>
            <StatusChip status={r.status} />
          </View>
          <Text style={s.cardMeta}>
            {fmtDateTime(r.departure_datetime)} · {r.seats_total} seat
            {r.seats_total === 1 ? "" : "s"} · ₹{Math.round(r.price_per_seat)}
          </Text>
        </TouchableOpacity>
      ))}
      {history && drove.length === 0 ? (
        <Empty
          icon="time-outline"
          title="No past rides"
          text="Rides you've driven will appear here."
        />
      ) : null}
    </>
  );
}

function Section({ title }: { title: string }) {
  return <Text style={s.section}>{title}</Text>;
}

function StatusChip({ status }: { status: string }) {
  const tone =
    status === "Confirmed" || status === "Published"
      ? colors.success
      : status === "Cancelled"
        ? colors.danger
        : colors.text;
  return (
    <View style={[s.chip, { backgroundColor: tone }]}>
      <Text style={s.chipText}>{status}</Text>
    </View>
  );
}

function Empty({ icon, title, text }: { icon: any; title: string; text: string }) {
  return (
    <View style={s.empty}>
      <Ionicons name={icon} size={28} color={colors.mute} />
      <Text style={s.emptyTitle}>{title}</Text>
      <Text style={s.emptyText}>{text}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg },
  h1: { fontSize: 26, fontWeight: "800", color: colors.text, letterSpacing: -0.4 },
  sub: { fontSize: 14, color: colors.soft, marginTop: 4, marginBottom: spacing(4) },
  section: {
    fontSize: 11,
    color: colors.soft,
    textTransform: "uppercase",
    fontWeight: "700",
    letterSpacing: 0.5,
    marginTop: spacing(5),
    marginBottom: spacing(2),
    paddingHorizontal: 4
  },
  card: {
    backgroundColor: colors.card,
    padding: spacing(4),
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing(3)
  },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  cardRoute: { fontSize: 16, fontWeight: "700", color: colors.text, flex: 1, letterSpacing: -0.2 },
  cardMeta: { fontSize: 12, color: colors.soft, marginTop: 6 },

  activeCard: {
    backgroundColor: colors.text,
    borderRadius: radii.lg,
    padding: spacing(4),
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: spacing(3)
  },
  activeIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center"
  },
  activeTitle: { color: colors.primaryText, fontSize: 15, fontWeight: "700" },
  activeSub: { color: "rgba(255,255,255,0.75)", fontSize: 12, marginTop: 2 },

  chip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  chipText: { color: colors.primaryText, fontSize: 11, fontWeight: "700" },

  empty: {
    backgroundColor: colors.bgAlt,
    borderRadius: radii.lg,
    padding: spacing(5),
    alignItems: "center",
    gap: 6
  },
  emptyTitle: { color: colors.text, fontSize: 15, fontWeight: "700", marginTop: 4 },
  emptyText: { color: colors.soft, fontSize: 12 },

  tabRow: {
    flexDirection: "row",
    backgroundColor: colors.bgAlt,
    borderRadius: 999,
    padding: 4,
    marginBottom: spacing(3),
    borderWidth: 1,
    borderColor: colors.border
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 9,
    alignItems: "center",
    borderRadius: 999
  },
  tabBtnActive: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border
  },
  tabBtnText: { color: colors.soft, fontSize: 13, fontWeight: "700" },
  tabBtnTextActive: { color: colors.text }
});
