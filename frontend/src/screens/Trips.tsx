import React, { useCallback, useState } from "react";
import { View, Text, FlatList, RefreshControl, TouchableOpacity, StyleSheet } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { call } from "@/api/client";
import { colors, radii, spacing } from "@/theme";
import type { RootStackParamList } from "@/navigation/RootNavigator";

type Nav = NativeStackNavigationProp<RootStackParamList, "Tabs">;

type Dashboard = {
  upcoming_bookings: any[];
  upcoming_rides: any[];
  active_trip_as_passenger: { booking: string; ride: string } | null;
  active_trip_as_driver: { name: string } | null;
};

export function TripsScreen() {
  const nav = useNavigation<Nav>();
  const [data, setData] = useState<Dashboard | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const d = await call<Dashboard>("rideshare.api.mobile.home_dashboard");
      setData(d);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <View style={s.shell}>
      <FlatList
        contentContainerStyle={{ padding: spacing(4) }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} />}
        data={[]}
        renderItem={null}
        ListHeaderComponent={
          <>
            {data?.active_trip_as_passenger ? (
              <TouchableOpacity
                style={[s.card, { backgroundColor: "#eef7fd", borderColor: colors.blue }]}
                onPress={() =>
                  nav.navigate("Tracking", {
                    rideId: data.active_trip_as_passenger!.ride,
                    role: "passenger"
                  })
                }
              >
                <Text style={s.cardTitle}>Trip in progress</Text>
                <Text style={s.cardMeta}>Tap to follow your driver on the map.</Text>
              </TouchableOpacity>
            ) : null}

            {data?.active_trip_as_driver ? (
              <TouchableOpacity
                style={[s.card, { backgroundColor: "#fef9ec", borderColor: colors.warn }]}
                onPress={() =>
                  nav.navigate("Tracking", {
                    rideId: data.active_trip_as_driver!.name,
                    role: "driver"
                  })
                }
              >
                <Text style={s.cardTitle}>You're driving</Text>
                <Text style={s.cardMeta}>Tap to broadcast your location to passengers.</Text>
              </TouchableOpacity>
            ) : null}

            <Section title="Upcoming bookings" />
            {(data?.upcoming_bookings || []).map((b) => (
              <TouchableOpacity key={b.name} style={s.card} onPress={() => nav.navigate("RideDetail", { rideId: b.ride })}>
                <Text style={s.cardTitle}>{b.origin_city} → {b.destination_city}</Text>
                <Text style={s.cardMeta}>
                  {new Date(b.departure_datetime).toLocaleString()} · {b.status} · {b.seats_booked} seat
                </Text>
              </TouchableOpacity>
            ))}
            {data && data.upcoming_bookings.length === 0 ? <Empty text="No upcoming rides booked yet." /> : null}

            <Section title="Rides you're driving" />
            {(data?.upcoming_rides || []).map((r) => (
              <TouchableOpacity key={r.name} style={s.card} onPress={() => nav.navigate("Tracking", { rideId: r.name, role: "driver" })}>
                <Text style={s.cardTitle}>{r.origin_city} → {r.destination_city}</Text>
                <Text style={s.cardMeta}>
                  {new Date(r.departure_datetime).toLocaleString()} · {r.status} · {r.seats_available}/{r.seats_total} seats left
                </Text>
              </TouchableOpacity>
            ))}
            {data && data.upcoming_rides.length === 0 ? <Empty text="You haven't published any rides yet." /> : null}
          </>
        }
      />
    </View>
  );
}

function Section({ title }: { title: string }) {
  return <Text style={s.section}>{title}</Text>;
}
function Empty({ text }: { text: string }) {
  return <Text style={{ color: colors.soft, fontSize: 13, paddingHorizontal: 4 }}>{text}</Text>;
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg },
  section: { fontSize: 12, color: colors.soft, textTransform: "uppercase", marginTop: spacing(4), marginBottom: spacing(2) },
  card: {
    backgroundColor: colors.card, padding: spacing(4), borderRadius: radii.lg,
    borderWidth: 1, borderColor: colors.border, marginBottom: spacing(3)
  },
  cardTitle: { fontSize: 16, fontWeight: "600", color: colors.text },
  cardMeta: { fontSize: 12, color: colors.soft, marginTop: 4 }
});
