// Live trip map.
//
// Two roles:
//  • Passenger: subscribes to ride:<id> via Socket.IO; falls back to a
//    5s REST poll when the socket disconnects.
//  • Driver:  uses expo-location's foreground watchPositionAsync to
//    push fixes via /push_location every 5s while the screen is open.
//    For real production background tracking, replace with a TaskManager
//    background task — wired in `services/backgroundLocation.ts` (TODO).

import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity, Alert } from "react-native";
import MapView, { Marker } from "react-native-maps";
import * as Location from "expo-location";
import { useRoute, RouteProp, useNavigation } from "@react-navigation/native";
import { call } from "@/api/client";
import { subscribeToRide, RideLocation } from "@/realtime/socket";
import { colors, radii, spacing } from "@/theme";
import type { RootStackParamList } from "@/navigation/RootNavigator";

type Route = RouteProp<RootStackParamList, "Tracking">;

const PUSH_INTERVAL_MS = 5000;
const POLL_INTERVAL_MS = 5000;

export function TrackingScreen() {
  const { params } = useRoute<Route>();
  const nav = useNavigation();
  const role = params.role ?? "passenger";

  const [loc, setLoc] = useState<RideLocation | null>(null);
  const [tripStatus, setTripStatus] = useState<string | null>(null);
  const [endpoints, setEndpoints] = useState<{ origin?: any; destination?: any }>({});
  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const pushRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastFix = useRef<{ lat: number; lng: number; heading?: number; speed?: number } | null>(null);

  useEffect(() => {
    let unsub: (() => void) | null = null;

    async function init() {
      // Always pull initial state once via REST (snappy first paint).
      try {
        const last = await call<any>("rideshare.api.tracking.get_last_location", { ride: params.rideId });
        if (last?.available) setLoc({
          ride: params.rideId,
          lat: last.lat,
          lng: last.lng,
          heading: last.heading,
          speed_kmh: last.speed_kmh,
          at: last.at
        });
        if (last?.status) setTripStatus(last.status);
        if (last?.origin && last?.destination) setEndpoints({ origin: last.origin, destination: last.destination });
      } catch {/* ignore */}

      if (role === "passenger") {
        try {
          unsub = await subscribeToRide(
            params.rideId,
            (l) => setLoc(l),
            (s) => setTripStatus(s.status)
          );
        } catch {
          // Socket failed — start REST polling fallback.
          pollRef.current = setInterval(async () => {
            try {
              const last = await call<any>("rideshare.api.tracking.get_last_location", { ride: params.rideId });
              if (last?.available) setLoc({
                ride: params.rideId,
                lat: last.lat,
                lng: last.lng,
                at: last.at
              });
            } catch {/* ignore */}
          }, POLL_INTERVAL_MS);
        }
      } else {
        // Driver: stream foreground location.
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") {
          Alert.alert("Location required", "Enable location to share your position with passengers.");
          return;
        }
        watchRef.current = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: 3000, distanceInterval: 10 },
          (pos) => {
            lastFix.current = {
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              heading: pos.coords.heading ?? undefined,
              speed: pos.coords.speed ?? undefined
            };
            setLoc({
              ride: params.rideId,
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              heading: pos.coords.heading,
              speed_kmh: pos.coords.speed ? pos.coords.speed * 3.6 : null,
              at: new Date().toISOString()
            });
          }
        );
        pushRef.current = setInterval(async () => {
          const f = lastFix.current;
          if (!f) return;
          try {
            await call("rideshare.api.tracking.push_location", {
              ride: params.rideId,
              lat: f.lat,
              lng: f.lng,
              heading: f.heading,
              speed_kmh: f.speed != null ? f.speed * 3.6 : undefined
            });
          } catch {/* ignore push failure; will retry next tick */}
        }, PUSH_INTERVAL_MS);
      }
    }

    init();
    return () => {
      if (unsub) unsub();
      if (watchRef.current) watchRef.current.remove();
      if (pushRef.current) clearInterval(pushRef.current);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [params.rideId, role]);

  async function startTrip() {
    await call("rideshare.api.tracking.start_trip", { ride: params.rideId });
    setTripStatus("InProgress");
  }
  async function completeTrip() {
    await call("rideshare.api.tracking.complete_trip", { ride: params.rideId });
    setTripStatus("Completed");
    nav.goBack();
  }

  if (!loc) {
    return (
      <View style={[s.shell, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator color={colors.blue} />
        <Text style={{ marginTop: 8, color: colors.soft }}>Waiting for location…</Text>
      </View>
    );
  }

  return (
    <View style={s.shell}>
      <MapView
        style={{ flex: 1 }}
        showsUserLocation={role === "driver"}
        region={{
          latitude: loc.lat,
          longitude: loc.lng,
          latitudeDelta: 0.05,
          longitudeDelta: 0.05
        }}
      >
        <Marker
          coordinate={{ latitude: loc.lat, longitude: loc.lng }}
          title={role === "driver" ? "You" : "Driver"}
          rotation={loc.heading ?? 0}
        />
        {endpoints.destination?.lat ? (
          <Marker
            coordinate={{ latitude: endpoints.destination.lat, longitude: endpoints.destination.lng }}
            title="Destination"
            pinColor="red"
          />
        ) : null}
      </MapView>

      <View style={s.bar}>
        <Text style={s.barText}>
          {role === "driver" ? "You're live to passengers" : "Following driver"} · {tripStatus ?? "—"}
        </Text>
        {role === "driver" && tripStatus !== "InProgress" ? (
          <TouchableOpacity style={s.btn} onPress={startTrip}>
            <Text style={s.btnText}>Start trip</Text>
          </TouchableOpacity>
        ) : null}
        {role === "driver" && tripStatus === "InProgress" ? (
          <TouchableOpacity style={[s.btn, { backgroundColor: colors.success }]} onPress={completeTrip}>
            <Text style={s.btnText}>Complete trip</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg },
  bar: {
    position: "absolute", left: 12, right: 12, bottom: 24,
    backgroundColor: colors.card, borderRadius: radii.lg, padding: spacing(3),
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    shadowColor: "#000", shadowOpacity: 0.1, shadowOffset: { width: 0, height: 4 }, shadowRadius: 8, elevation: 4
  },
  barText: { fontSize: 14, color: colors.text, flex: 1 },
  btn: { backgroundColor: colors.blue, paddingHorizontal: 14, paddingVertical: 10, borderRadius: radii.md },
  btnText: { color: "#fff", fontWeight: "600" }
});
