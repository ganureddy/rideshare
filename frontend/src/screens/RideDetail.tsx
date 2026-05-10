import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet, Alert } from "react-native";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import MapView, { Marker, Polyline } from "react-native-maps";
import { call } from "@/api/client";
import { colors, radii, spacing } from "@/theme";
import type { RootStackParamList } from "@/navigation/RootNavigator";

type Route = RouteProp<RootStackParamList, "RideDetail">;
type Nav = NativeStackNavigationProp<RootStackParamList, "RideDetail">;

type Summary = {
  name: string;
  driver: string;
  status: string;
  origin_city: string;
  origin_lat: number;
  origin_lng: number;
  destination_city: string;
  destination_lat: number;
  destination_lng: number;
  departure_datetime: string;
  duration_minutes: number;
  distance_km: number;
  seats_available: number;
  price_per_seat: number;
  description?: string;
  waypoints: { city: string; lat: number; lng: number; stop_order: number }[];
  driver_display: { name?: string; rating_avg?: number; rating_count?: number; is_verified?: boolean };
};

export function RideDetailScreen() {
  const { params } = useRoute<Route>();
  const nav = useNavigation<Nav>();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call<Summary>("rideshare.api.mobile.ride_summary", { ride: params.rideId })
      .then(setSummary)
      .catch((e) => Alert.alert("Could not load ride", e.message));
  }, [params.rideId]);

  if (!summary) {
    return (
      <View style={[s.shell, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator color={colors.blue} />
      </View>
    );
  }

  async function book() {
    setBusy(true);
    try {
      const res = await call<{ booking: string; amount: number; currency: string; gateway: string }>(
        "rideshare.api.bookings.create_booking",
        { ride: params.rideId, seats: 1 }
      );
      // For MVP DEMO mode the gateway is fake — confirm immediately so the
      // booking flips to Confirmed and the live map screen unlocks.
      await call("rideshare.api.bookings.confirm_payment", {
        booking: res.booking,
        gateway_payment_id: `demo_${Date.now()}`,
        gateway_signature: "demo"
      }).catch(() => {/* in real flow we'd open Razorpay checkout here */});
      Alert.alert("Booked!", "We'll alert you when the driver confirms.");
      nav.navigate("Tracking", { rideId: params.rideId, role: "passenger" });
    } catch (e: any) {
      Alert.alert("Booking failed", e?.message ?? "Try again.");
    } finally {
      setBusy(false);
    }
  }

  const region = {
    latitude: (summary.origin_lat + summary.destination_lat) / 2,
    longitude: (summary.origin_lng + summary.destination_lng) / 2,
    latitudeDelta: Math.abs(summary.origin_lat - summary.destination_lat) * 1.6 + 0.5,
    longitudeDelta: Math.abs(summary.origin_lng - summary.destination_lng) * 1.6 + 0.5
  };

  return (
    <ScrollView style={s.shell} contentContainerStyle={{ padding: spacing(4) }}>
      <View style={s.card}>
        <Text style={s.route}>
          {summary.origin_city} → {summary.destination_city}
        </Text>
        <Text style={s.meta}>
          {new Date(summary.departure_datetime).toLocaleString()} · {summary.distance_km} km · {summary.duration_minutes} min
        </Text>

        <View style={{ height: 220, borderRadius: radii.md, overflow: "hidden", marginTop: spacing(3) }}>
          <MapView style={{ flex: 1 }} initialRegion={region}>
            <Marker
              coordinate={{ latitude: summary.origin_lat, longitude: summary.origin_lng }}
              title={summary.origin_city}
              pinColor="green"
            />
            <Marker
              coordinate={{ latitude: summary.destination_lat, longitude: summary.destination_lng }}
              title={summary.destination_city}
              pinColor="red"
            />
            <Polyline
              coordinates={[
                { latitude: summary.origin_lat, longitude: summary.origin_lng },
                ...summary.waypoints.map((w) => ({ latitude: w.lat, longitude: w.lng })),
                { latitude: summary.destination_lat, longitude: summary.destination_lng }
              ]}
              strokeColor={colors.blue}
              strokeWidth={3}
            />
          </MapView>
        </View>

        <Text style={s.section}>Driver</Text>
        <Text style={s.body}>
          {summary.driver_display.name}
          {summary.driver_display.is_verified ? " · ✓ Verified" : ""}
          {summary.driver_display.rating_count
            ? ` · ★ ${summary.driver_display.rating_avg?.toFixed(1)} (${summary.driver_display.rating_count})`
            : ""}
        </Text>

        {summary.description ? (
          <>
            <Text style={s.section}>Notes</Text>
            <Text style={s.body}>{summary.description}</Text>
          </>
        ) : null}

        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: spacing(4) }}>
          <Text style={s.price}>₹{Math.round(summary.price_per_seat)}</Text>
          <TouchableOpacity style={[s.btn, busy && { opacity: 0.6 }]} onPress={book} disabled={busy || summary.seats_available <= 0}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>Book a seat</Text>}
          </TouchableOpacity>
        </View>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg },
  card: { backgroundColor: colors.card, padding: spacing(4), borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border },
  route: { fontSize: 20, fontWeight: "700", color: colors.text },
  meta: { color: colors.soft, fontSize: 13, marginTop: 4 },
  section: { fontSize: 12, color: colors.soft, marginTop: spacing(4), textTransform: "uppercase" },
  body: { fontSize: 15, color: colors.text, marginTop: 4 },
  price: { fontSize: 22, fontWeight: "700", color: colors.text },
  btn: { backgroundColor: colors.blue, paddingHorizontal: 18, paddingVertical: 12, borderRadius: radii.md },
  btnText: { color: "#fff", fontWeight: "600" }
});
