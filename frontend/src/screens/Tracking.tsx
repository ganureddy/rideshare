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
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Alert
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import MapView, { Marker, Polyline, PROVIDER_DEFAULT } from "react-native-maps";
import * as Location from "expo-location";
import { useRoute, RouteProp, useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { call } from "@/api/client";
import { subscribeToRide, RideLocation } from "@/realtime/socket";
import { colors, radii, spacing, shadow } from "@/theme";
import type { RootStackParamList } from "@/navigation/RootNavigator";

type Route = RouteProp<RootStackParamList, "Tracking">;

const PUSH_INTERVAL_MS = 5000;
const POLL_INTERVAL_MS = 5000;

type Endpoints = {
  origin?: { lat: number; lng: number } | null;
  destination?: { lat: number; lng: number } | null;
};

export function TrackingScreen() {
  const { params } = useRoute<Route>();
  const nav = useNavigation();
  const role = params.role ?? "passenger";

  const [loc, setLoc] = useState<RideLocation | null>(null);
  const [tripStatus, setTripStatus] = useState<string | null>(null);
  const [endpoints, setEndpoints] = useState<Endpoints>({});
  const [staleSeconds, setStaleSeconds] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const pushRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastFix = useRef<{ lat: number; lng: number; heading?: number; speed?: number } | null>(null);
  const mapRef = useRef<MapView | null>(null);

  useEffect(() => {
    let unsub: (() => void) | null = null;

    async function init() {
      try {
        const last = await call<any>("rideshare.api.tracking.get_last_location", {
          ride: params.rideId
        });
        if (last?.available) {
          setLoc({
            ride: params.rideId,
            lat: last.lat,
            lng: last.lng,
            heading: last.heading,
            speed_kmh: last.speed_kmh,
            at: last.at
          });
        }
        if (last?.status) setTripStatus(last.status);
        if (typeof last?.stale_seconds === "number") setStaleSeconds(last.stale_seconds);
        if (last?.origin && last?.destination)
          setEndpoints({ origin: last.origin, destination: last.destination });
      } catch {
        /* ignore */
      }

      if (role === "passenger") {
        try {
          unsub = await subscribeToRide(
            params.rideId,
            (l) => {
              setLoc(l);
              setStaleSeconds(0);
            },
            (st) => setTripStatus(st.status)
          );
        } catch {
          pollRef.current = setInterval(async () => {
            try {
              const last = await call<any>("rideshare.api.tracking.get_last_location", {
                ride: params.rideId
              });
              if (last?.available) {
                setLoc({
                  ride: params.rideId,
                  lat: last.lat,
                  lng: last.lng,
                  heading: last.heading,
                  speed_kmh: last.speed_kmh,
                  at: last.at
                });
              }
              if (typeof last?.stale_seconds === "number") setStaleSeconds(last.stale_seconds);
              if (last?.status) setTripStatus(last.status);
            } catch {/* ignore */}
          }, POLL_INTERVAL_MS);
        }
      } else {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") {
          Alert.alert(
            "Location required",
            "Enable location to share your position with passengers."
          );
          return;
        }
        watchRef.current = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            timeInterval: 3000,
            distanceInterval: 10
          },
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
            setStaleSeconds(0);
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
          } catch {/* retry next tick */}
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

  // Smoothly recentre the map on the latest fix.
  useEffect(() => {
    if (!loc || !mapRef.current) return;
    mapRef.current.animateCamera(
      {
        center: { latitude: loc.lat, longitude: loc.lng },
        heading: loc.heading ?? 0,
        pitch: 0,
        zoom: 15
      },
      { duration: 700 }
    );
  }, [loc]);

  async function startTrip() {
    setBusy(true);
    try {
      await call("rideshare.api.tracking.start_trip", { ride: params.rideId });
      setTripStatus("InProgress");
    } catch (e: any) {
      Alert.alert("Couldn't start", e?.message ?? "Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function completeTrip() {
    Alert.alert("Complete trip?", "This will release payment after the cooldown.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Complete",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            await call("rideshare.api.tracking.complete_trip", { ride: params.rideId });
            setTripStatus("Completed");
            nav.goBack();
          } catch (e: any) {
            Alert.alert("Couldn't complete", e?.message ?? "Try again.");
          } finally {
            setBusy(false);
          }
        }
      }
    ]);
  }

  if (!loc) {
    return (
      <View style={[s.shell, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator color={colors.text} />
        <Text style={{ marginTop: 8, color: colors.soft }}>
          {role === "driver" ? "Locating you…" : "Waiting for driver location…"}
        </Text>
      </View>
    );
  }

  const fresh = staleSeconds == null || staleSeconds < 30;

  return (
    <View style={s.shell}>
      <MapView
        ref={(m) => { mapRef.current = m; }}
        style={{ flex: 1 }}
        provider={PROVIDER_DEFAULT}
        showsUserLocation={role === "driver"}
        showsCompass
        initialRegion={{
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
          flat
          anchor={{ x: 0.5, y: 0.5 }}
        >
          <View style={s.driverPin}>
            <Ionicons name="car" size={16} color={colors.primaryText} />
          </View>
        </Marker>
        {endpoints.origin?.lat ? (
          <Marker
            coordinate={{ latitude: endpoints.origin.lat, longitude: endpoints.origin.lng }}
            title="Pickup"
            pinColor={colors.pickupPin}
          />
        ) : null}
        {endpoints.destination?.lat ? (
          <Marker
            coordinate={{
              latitude: endpoints.destination.lat,
              longitude: endpoints.destination.lng
            }}
            title="Destination"
            pinColor={colors.dropoffPin}
          />
        ) : null}
        {endpoints.origin?.lat && endpoints.destination?.lat ? (
          <Polyline
            coordinates={[
              { latitude: endpoints.origin.lat, longitude: endpoints.origin.lng },
              { latitude: endpoints.destination.lat, longitude: endpoints.destination.lng }
            ]}
            strokeColor={colors.text}
            strokeWidth={2}
          />
        ) : null}
      </MapView>

      {/* Top bar: status + back */}
      <SafeAreaView style={s.topBar} edges={["top"]} pointerEvents="box-none">
        <View style={s.topBarInner}>
          <TouchableOpacity onPress={() => nav.goBack()} style={s.topBackBtn} activeOpacity={0.8}>
            <Ionicons name="chevron-back" size={20} color={colors.text} />
          </TouchableOpacity>
          <View style={[s.statusPill, !fresh && s.statusStale]}>
            <View style={[s.dot, !fresh && { backgroundColor: colors.warn }]} />
            <Text style={s.statusText}>
              {tripStatus || "Live"}
              {!fresh && staleSeconds != null ? `  ·  ${staleSeconds}s ago` : ""}
            </Text>
          </View>
          {loc.speed_kmh != null && loc.speed_kmh > 0 ? (
            <View style={s.speedPill}>
              <Text style={s.speedText}>{Math.round(loc.speed_kmh)} km/h</Text>
            </View>
          ) : (
            <View style={{ width: 40 }} />
          )}
        </View>
      </SafeAreaView>

      {/* Bottom bar */}
      <SafeAreaView style={s.bottomBar} edges={["bottom"]} pointerEvents="box-none">
        <View style={[s.bottomCard, shadow.floating]}>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>
              {role === "driver" ? "You're sharing your location" : "Following the driver"}
            </Text>
            <Text style={s.cardSub}>
              {tripStatus === "InProgress"
                ? "Trip in progress"
                : tripStatus === "Completed"
                  ? "Trip completed"
                  : "Waiting to start"}
            </Text>
          </View>
          {role === "driver" && tripStatus !== "InProgress" && tripStatus !== "Completed" ? (
            <TouchableOpacity style={s.btn} onPress={startTrip} disabled={busy} activeOpacity={0.85}>
              <Text style={s.btnText}>Start trip</Text>
            </TouchableOpacity>
          ) : null}
          {role === "driver" && tripStatus === "InProgress" ? (
            <TouchableOpacity
              style={[s.btn, { backgroundColor: colors.success }]}
              onPress={completeTrip}
              disabled={busy}
              activeOpacity={0.85}
            >
              <Text style={s.btnText}>Complete</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bgAlt },
  topBar: { position: "absolute", left: 0, right: 0, top: 0 },
  topBarInner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing(4),
    paddingTop: spacing(2),
    gap: 8
  },
  topBackBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
    ...shadow.floating
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.card,
    ...shadow.floating
  },
  statusStale: { backgroundColor: "#FFF8E1" },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.success },
  statusText: { color: colors.text, fontSize: 12, fontWeight: "700" },
  speedPill: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.text
  },
  speedText: { color: colors.primaryText, fontSize: 12, fontWeight: "700" },

  bottomBar: { position: "absolute", left: 0, right: 0, bottom: 0 },
  bottomCard: {
    flexDirection: "row",
    alignItems: "center",
    margin: spacing(4),
    backgroundColor: colors.card,
    borderRadius: radii.lg,
    padding: spacing(4),
    gap: 10,
    borderWidth: 1,
    borderColor: colors.border
  },
  cardTitle: { fontSize: 15, fontWeight: "700", color: colors.text },
  cardSub: { fontSize: 12, color: colors.soft, marginTop: 2 },
  btn: {
    backgroundColor: colors.primary,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 999
  },
  btnText: { color: colors.primaryText, fontWeight: "700", fontSize: 14 },

  driverPin: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.text,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: "#fff",
    ...shadow.floating
  }
});
