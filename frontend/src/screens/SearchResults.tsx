import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  RefreshControl
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Image } from "react-native";
import { call } from "@/api/client";
import { CarLoader } from "@/components/CarLoader";
import { absoluteFileUrl } from "@/utils/upload";
import { colors, radii, spacing } from "@/theme";
import type { RootStackParamList } from "@/navigation/RootNavigator";
import { fmtDate, fmtTime } from "@/utils/dateUtils";

// Minimum time the search loader stays visible.  The animated loader
// loops every 4 s; clamping the display time guarantees the user always
// sees at least one full cycle even when the search API answers in
// <100 ms (cached / nearby city pair).
const MIN_LOADER_MS = 4000;

type Route = RouteProp<RootStackParamList, "SearchResults">;
type Nav = NativeStackNavigationProp<RootStackParamList, "SearchResults">;

type Ride = {
  name: string;
  driver: string;
  driver_name?: string;
  driver_initials?: string;
  driver_image?: string | null;
  driver_avg_rating?: number;
  driver_total_reviews?: number;
  driver_total_trips?: number;
  driver_is_verified?: boolean;
  origin_city: string;
  destination_city: string;
  origin_address?: string;
  destination_address?: string;
  departure_datetime: string;
  duration_minutes?: number;
  distance_km?: number;
  seats_available: number;
  price_per_seat: number;
  women_only?: number;
  instant_booking?: number;
  vehicle_photo?: string | null;
};

export function SearchResultsScreen() {
  const route = useRoute<Route>();
  const nav = useNavigation<Nav>();
  const [items, setItems] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const heading = useMemo(() => {
    const a = route.params?.origin?.label || "From";
    const b = route.params?.destination?.label || "To";
    return `${a} → ${b}`;
  }, [route.params]);

  async function fetchRides() {
    const origin = route.params?.origin;
    const destination = route.params?.destination;
    const res = await call<{ rides: Ride[]; results?: Ride[] }>(
      "rideshare.api.search.search_rides",
      {
        origin: origin?.id,
        destination: destination?.id,
        date: route.params?.date,
        seats: route.params?.seats ?? 1,
        sort: route.params?.sort || "departure",
        instant_booking: route.params?.instantOnly || 0,
        women_only: route.params?.womenOnly || 0,
        max_price: route.params?.maxPrice ?? undefined,
        limit: 50
      }
    );
    setItems((res as any).rides || (res as any).results || []);
  }

  useEffect(() => {
    setLoading(true);
    const minDelay = new Promise<void>((resolve) =>
      setTimeout(resolve, MIN_LOADER_MS)
    );
    Promise.all([fetchRides().catch(() => setItems([])), minDelay]).finally(() =>
      setLoading(false)
    );
    // fetchRides is recreated each render but reads only from route.params.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params]);

  async function onRefresh() {
    setRefreshing(true);
    try {
      await fetchRides();
    } finally {
      setRefreshing(false);
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={s.shell} edges={["top"]}>
        <View style={s.headerWrap}>
          <Text style={s.heading} numberOfLines={1}>{heading}</Text>
          <Text style={s.headerSub}>
            {(route.params?.seats ?? 1)} seat · {route.params?.date ? fmtDate(route.params.date) : "Any date"}
          </Text>
        </View>
        <CarLoader label="Finding your ride…" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.shell} edges={["bottom"]}>
      <View style={s.headerWrap}>
        <Text style={s.heading} numberOfLines={1}>{heading}</Text>
        <Text style={s.headerSub}>
          {(route.params?.seats ?? 1)} seat · {route.params?.date ? fmtDate(route.params.date) : "Any date"}
        </Text>
      </View>

      <FlatList
        data={items.filter((it) => it && typeof it.name === "string")}
        keyExtractor={(it) => it.name}
        contentContainerStyle={{ padding: spacing(4), gap: spacing(3) }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          <View style={s.empty}>
            <Ionicons name="car-outline" size={48} color={colors.mute} />
            <Text style={s.emptyTitle}>No rides match yet.</Text>
            <Text style={s.emptyText}>Try a different date or widen the area.</Text>
          </View>
        }
        renderItem={({ item }) => {
          const rating = Number(item.driver_avg_rating);
          const price = Number(item.price_per_seat);
          const seats = Number(item.seats_available);
          return (
            <TouchableOpacity
              style={s.card}
              activeOpacity={0.85}
              onPress={() => nav.navigate("RideDetail", { rideId: item.name })}
            >
              <View style={s.cardTopRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.time}>{fmtTime(item.departure_datetime) || "—"}</Text>
                  <Text style={s.dateLine}>{fmtDate(item.departure_datetime) || "—"}</Text>
                </View>
                <Text style={s.price}>₹{Math.round(Number.isFinite(price) ? price : 0)}</Text>
              </View>

              <View style={s.routeRow}>
                <View style={s.routeIcons}>
                  <View style={s.routeDot} />
                  <View style={s.routeLine} />
                  <View style={[s.routeDot, { backgroundColor: colors.dropoffPin }]} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.routeText} numberOfLines={1}>{item.origin_city || "—"}</Text>
                  <View style={{ height: 18 }} />
                  <Text style={s.routeText} numberOfLines={1}>{item.destination_city || "—"}</Text>
                </View>
              </View>

              <View style={s.driverRow}>
                {(() => {
                  const carUri = item.vehicle_photo ? absoluteFileUrl(item.vehicle_photo) : null;
                  const driverUri = item.driver_image ? absoluteFileUrl(item.driver_image) : null;
                  return (
                    <View style={s.thumbStack}>
                      {carUri ? (
                        <Image source={{ uri: carUri }} style={s.carThumb} resizeMode="cover" />
                      ) : (
                        <View style={[s.carThumb, s.carThumbStub]}>
                          <Ionicons name="car-sport" size={20} color={colors.soft} />
                        </View>
                      )}
                      {driverUri ? (
                        <Image source={{ uri: driverUri }} style={s.avatarOverlay} />
                      ) : (
                        <View style={[s.avatarOverlay, s.avatar]}>
                          <Text style={s.avatarText}>{item.driver_initials || "D"}</Text>
                        </View>
                      )}
                    </View>
                  );
                })()}
                <View style={{ flex: 1, marginLeft: 4 }}>
                  <Text style={s.driverName} numberOfLines={1}>
                    {item.driver_name || "Driver"}
                    {item.driver_is_verified ? "  ✓" : ""}
                  </Text>
                  <Text style={s.driverMeta}>
                    {Number.isFinite(rating) && rating > 0
                      ? `★ ${rating.toFixed(1)}${
                          item.driver_total_reviews
                            ? ` (${item.driver_total_reviews})`
                            : ""
                        } · `
                      : ""}
                    {Number.isFinite(seats) ? seats : 0} seat
                    {seats === 1 ? "" : "s"} left
                  </Text>
                </View>
                <View style={{ flexDirection: "row", gap: 6 }}>
                  {item.instant_booking ? <Chip text="Instant" /> : null}
                  {item.women_only ? <Chip text="Women only" /> : null}
                </View>
              </View>
            </TouchableOpacity>
          );
        }}
      />
    </SafeAreaView>
  );
}

function Chip({ text }: { text: string }) {
  return (
    <View style={s.chip}>
      <Text style={s.chipText}>{text}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg },
  headerWrap: {
    paddingHorizontal: spacing(4),
    paddingTop: spacing(2),
    paddingBottom: spacing(3),
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card
  },
  heading: { fontSize: 18, fontWeight: "700", color: colors.text, letterSpacing: -0.2 },
  headerSub: { color: colors.soft, fontSize: 13, marginTop: 2 },

  card: {
    backgroundColor: colors.card,
    padding: spacing(4),
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border
  },
  cardTopRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  time: { fontSize: 20, fontWeight: "800", color: colors.text, letterSpacing: -0.5 },
  dateLine: { fontSize: 12, color: colors.soft, marginTop: 2 },
  price: { fontSize: 22, fontWeight: "800", color: colors.text, letterSpacing: -0.5 },

  routeRow: { flexDirection: "row", marginTop: spacing(3), gap: 12 },
  routeIcons: { width: 14, alignItems: "center", paddingTop: 6 },
  routeDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.text },
  routeLine: { width: 2, flex: 1, backgroundColor: colors.borderStrong, marginVertical: 2 },
  routeText: { fontSize: 15, fontWeight: "600", color: colors.text },

  driverRow: { flexDirection: "row", alignItems: "center", marginTop: spacing(3), gap: 10 },
  thumbStack: {
    width: 64,
    height: 48,
    position: "relative"
  },
  carThumb: {
    width: 64,
    height: 48,
    borderRadius: 8,
    backgroundColor: colors.bgAlt,
    borderWidth: 1,
    borderColor: colors.border
  },
  carThumbStub: {
    alignItems: "center",
    justifyContent: "center"
  },
  avatarOverlay: {
    position: "absolute",
    right: -8,
    bottom: -8,
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: colors.card,
    backgroundColor: colors.text,
    overflow: "hidden"
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.text,
    alignItems: "center",
    justifyContent: "center"
  },
  avatarText: { color: colors.primaryText, fontSize: 11, fontWeight: "800" },
  driverName: { fontSize: 14, fontWeight: "600", color: colors.text },
  driverMeta: { fontSize: 12, color: colors.soft, marginTop: 2 },

  chip: {
    backgroundColor: colors.bgAlt,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999
  },
  chipText: { color: colors.text, fontSize: 11, fontWeight: "700" },

  empty: { padding: spacing(10), alignItems: "center", gap: 8 },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: "700", marginTop: 8 },
  emptyText: { color: colors.soft, fontSize: 13, textAlign: "center" }
});
