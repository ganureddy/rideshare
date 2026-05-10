import React, { useEffect, useState } from "react";
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, StyleSheet } from "react-native";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { call } from "@/api/client";
import { colors, radii, spacing } from "@/theme";
import type { RootStackParamList } from "@/navigation/RootNavigator";

type Route = RouteProp<RootStackParamList, "SearchResults">;
type Nav = NativeStackNavigationProp<RootStackParamList, "SearchResults">;

type Ride = {
  name: string;
  driver: string;
  driver_name?: string;
  origin_city: string;
  destination_city: string;
  origin_address?: string;
  destination_address?: string;
  departure_datetime: string;
  duration_minutes?: number;
  seats_available: number;
  price_per_seat: number;
  women_only?: number;
  instant_booking?: number;
};

export function SearchResultsScreen() {
  const route = useRoute<Route>();
  const nav = useNavigation<Nav>();
  const [items, setItems] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        // The backend's segment-matching means a ride A→Z with waypoint M
        // appears for an A→M query as long as the City rows match.
        // For free-text places, we resolve to City names server-side later;
        // for MVP we send city names if known, falling back to primary_text.
        const originCity = route.params?.origin?.city || route.params?.origin?.primary_text;
        const destCity = route.params?.destination?.city || route.params?.destination?.primary_text;
        const res = await call<{ rides: Ride[]; total: number }>("rideshare.api.search.search_rides", {
          origin: originCity,
          destination: destCity,
          date: route.params?.date,
          seats: route.params?.seats ?? 1,
          sort: "departure",
          limit: 30
        });
        setItems((res as any).rides || (res as any) || []);
      } finally {
        setLoading(false);
      }
    })();
  }, [route.params]);

  if (loading) {
    return (
      <View style={[s.shell, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator color={colors.blue} />
      </View>
    );
  }

  return (
    <View style={s.shell}>
      <FlatList
        data={items}
        keyExtractor={(it) => it.name}
        contentContainerStyle={{ padding: spacing(4), gap: spacing(3) }}
        ListEmptyComponent={
          <Text style={{ color: colors.soft, textAlign: "center", marginTop: 40 }}>
            No rides match your filters yet. Try a different date or wider area.
          </Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={s.card}
            onPress={() => nav.navigate("RideDetail", { rideId: item.name })}
          >
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <View>
                <Text style={s.route}>
                  {item.origin_city} → {item.destination_city}
                </Text>
                <Text style={s.meta}>
                  {new Date(item.departure_datetime).toLocaleString()} ·{" "}
                  {item.seats_available} seat{item.seats_available === 1 ? "" : "s"} left
                </Text>
              </View>
              <Text style={s.price}>₹{Math.round(item.price_per_seat)}</Text>
            </View>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
              {item.instant_booking ? <Chip text="Instant" /> : null}
              {item.women_only ? <Chip text="Women only" /> : null}
              {item.duration_minutes ? <Chip text={`${item.duration_minutes} min`} /> : null}
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

function Chip({ text }: { text: string }) {
  return (
    <View style={{ backgroundColor: "#eef7fd", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 }}>
      <Text style={{ color: colors.blueDark, fontSize: 12, fontWeight: "600" }}>{text}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg },
  card: { backgroundColor: colors.card, padding: spacing(4), borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border },
  route: { fontSize: 16, fontWeight: "600", color: colors.text },
  meta: { color: colors.soft, marginTop: 2, fontSize: 12 },
  price: { fontSize: 20, fontWeight: "700", color: colors.text }
});
