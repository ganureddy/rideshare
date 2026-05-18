// Live trip map — two-way GPS tracking on free, open-source infra.
//
// Stack
// -----
//   Map tiles:    OpenStreetMap raster via <UrlTile> (no Google key, no quota)
//   Driver GPS:   expo-location (device chip — no API cost ever)
//   Passenger GPS: expo-location (same)
//   Route + ETA:  OSRM, proxied through the backend at
//                 rideshare.api.routing.route / route_to_ride
//   Realtime:     Frappe Socket.IO bridge on room ride:<id>
//                 events: rideshare:location, rideshare:passenger_location,
//                         rideshare:status
//
// Roles
// -----
//   driver:     pushes its own GPS to push_location every PUSH_INTERVAL_MS
//               and renders the latest fix of every passenger on the ride.
//   passenger:  pushes its own GPS to push_passenger_location and renders
//               the driver's latest fix + a road-snapped polyline from
//               driver → destination with an ETA.
//
// Both roles get OSM tiles via <UrlTile>, so the only reason you'd need
// a Google Maps key now is if you choose to set provider=PROVIDER_GOOGLE
// (we deliberately don't).

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
  Animated,
  Easing,
  ScrollView
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import MapView, {
  Marker,
  Polyline,
  UrlTile,
  PROVIDER_DEFAULT
} from "react-native-maps";
import * as Location from "expo-location";
import { useRoute, RouteProp, useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { call } from "@/api/client";
import {
  subscribeToRide,
  RideLocation,
  PassengerLocation
} from "@/realtime/socket";
import { colors, radii, spacing, shadow } from "@/theme";
import type { RootStackParamList } from "@/navigation/RootNavigator";

type Route = RouteProp<RootStackParamList, "Tracking">;

// Push cadence — small enough that "where is he now?" stays fresh,
// big enough that we don't drain the battery or chew data.
const PUSH_INTERVAL_MS = 10_000;
// REST polling fallback when the websocket disconnects.
const POLL_INTERVAL_MS = 15_000;
// Re-run OSRM no more than once per ROUTE_REFRESH_MS to stay polite to the
// public demo server and to limit work on a self-hosted instance.
const ROUTE_REFRESH_MS = 30_000;
// Don't bother re-routing if the driver hasn't moved further than this.
const ROUTE_RECOMPUTE_DISTANCE_M = 250;

// Tile providers — keep both keys here and switch by changing OSM_TILE_URL.
// tile.openstreetmap.org is fine for dev; for production swap to a
// commercial-friendly source (OpenFreeMap, MapTiler free tier, or
// self-hosted tileserver-gl).
const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

type Endpoints = {
  origin?: { lat: number; lng: number } | null;
  destination?: { lat: number; lng: number } | null;
};

type RouteInfo = {
  polyline: { latitude: number; longitude: number }[];
  distance_km: number;
  eta_minutes: number;
  engine: string;
};

type PassengerPin = {
  booking: string;
  passenger: string;
  lat: number;
  lng: number;
  heading?: number | null;
  speed_kmh?: number | null;
  at?: string | null;
  stale_seconds?: number | null;
};

function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function TrackingScreen() {
  const { params } = useRoute<Route>();
  const nav = useNavigation();
  const role = params.role ?? "passenger";
  const bookingId = params.bookingId ?? null;

  // Latest driver fix (rendered for everyone).
  const [driverLoc, setDriverLoc] = useState<RideLocation | null>(null);
  // Latest passenger fixes, keyed by booking id (rendered for driver and
  // for passengers showing their own pin).
  const [passengerPins, setPassengerPins] = useState<Record<string, PassengerPin>>(
    {}
  );
  // Ride endpoints (origin + destination) for fallback rendering.
  const [endpoints, setEndpoints] = useState<Endpoints>({});
  const [tripStatus, setTripStatus] = useState<string | null>(null);
  const [staleSeconds, setStaleSeconds] = useState<number | null>(null);
  const [routeInfo, setRouteInfo] = useState<RouteInfo | null>(null);
  const [busy, setBusy] = useState(false);

  // Driver's own GPS, kept in a ref so the push interval can read the
  // freshest value without re-running the interval.
  const myFix = useRef<{
    lat: number;
    lng: number;
    heading?: number | null;
    speed?: number | null;
  } | null>(null);

  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const pushRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const routeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastRouteAt = useRef<number>(0);
  const lastRouteFrom = useRef<{ lat: number; lng: number } | null>(null);
  const mapRef = useRef<MapView | null>(null);

  // ---------------------------------------------------------------------
  // Route + ETA refresh.  Computes a road-snapped polyline from the
  // driver's current position to the ride destination via OSRM (free,
  // open-source) and caches the result for ROUTE_REFRESH_MS.
  // ---------------------------------------------------------------------
  const refreshRoute = useCallback(async () => {
    if (!driverLoc) return;
    const now = Date.now();
    if (now - lastRouteAt.current < ROUTE_REFRESH_MS) return;
    const lf = lastRouteFrom.current;
    if (
      lf &&
      distanceMeters(lf, { lat: driverLoc.lat, lng: driverLoc.lng }) <
        ROUTE_RECOMPUTE_DISTANCE_M
    ) {
      return;
    }
    try {
      const r = await call<{
        ok: boolean;
        distance_km: number;
        eta_minutes: number;
        polyline: number[][];
        engine: string;
      }>("rideshare.api.routing.route_to_ride", { ride: params.rideId });
      const poly = (r.polyline || []).map(([lat, lng]) => ({
        latitude: lat,
        longitude: lng
      }));
      setRouteInfo({
        polyline: poly,
        distance_km: r.distance_km,
        eta_minutes: r.eta_minutes,
        engine: r.engine
      });
      lastRouteAt.current = now;
      lastRouteFrom.current = { lat: driverLoc.lat, lng: driverLoc.lng };
    } catch {
      /* OSRM hiccup — keep the previous polyline on-screen */
    }
  }, [driverLoc, params.rideId]);

  useEffect(() => {
    refreshRoute();
  }, [refreshRoute]);

  // ---------------------------------------------------------------------
  // Lifecycle: bootstrap, subscribe, start pushing.
  // ---------------------------------------------------------------------
  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;

    async function init() {
      // 1. Hydrate from the latest server snapshot so the screen never
      //    shows a blank map while waiting for the first socket event.
      try {
        const last = await call<any>(
          "rideshare.api.tracking.get_last_location",
          { ride: params.rideId }
        );
        if (cancelled) return;
        if (last?.available) {
          setDriverLoc({
            ride: params.rideId,
            lat: last.lat,
            lng: last.lng,
            heading: last.heading,
            speed_kmh: last.speed_kmh,
            at: last.at
          });
        }
        if (last?.status) setTripStatus(last.status);
        if (typeof last?.stale_seconds === "number")
          setStaleSeconds(last.stale_seconds);
        if (last?.origin && last?.destination) {
          setEndpoints({ origin: last.origin, destination: last.destination });
        }
      } catch {
        /* ignore */
      }

      // 1b. Hydrate passenger pins for the driver.
      try {
        const px = await call<{ passengers: PassengerPin[] }>(
          "rideshare.api.tracking.get_passenger_locations",
          { ride: params.rideId }
        );
        if (cancelled) return;
        const next: Record<string, PassengerPin> = {};
        for (const p of px.passengers || []) {
          if (p.lat != null && p.lng != null) next[p.booking] = p;
        }
        setPassengerPins(next);
      } catch {
        /* ignore */
      }

      // 2. Subscribe to realtime updates.  The same room handles driver
      //    fixes, passenger fixes, and status changes — see backend
      //    rideshare.api.tracking.
      try {
        unsub = await subscribeToRide(
          params.rideId,
          (l) => {
            setDriverLoc(l);
            setStaleSeconds(0);
          },
          (st) => setTripStatus(st.status),
          (pl: PassengerLocation) => {
            setPassengerPins((prev) => ({
              ...prev,
              [pl.booking]: {
                booking: pl.booking,
                passenger: pl.passenger,
                lat: pl.lat,
                lng: pl.lng,
                heading: pl.heading,
                speed_kmh: pl.speed_kmh,
                at: pl.at
              }
            }));
          }
        );
      } catch {
        // Socket dead — fall back to REST polling.  We poll both the
        // driver fix and the passenger pins so the driver still sees
        // their riders even without a websocket.
        pollRef.current = setInterval(async () => {
          try {
            const last = await call<any>(
              "rideshare.api.tracking.get_last_location",
              { ride: params.rideId }
            );
            if (last?.available) {
              setDriverLoc({
                ride: params.rideId,
                lat: last.lat,
                lng: last.lng,
                heading: last.heading,
                speed_kmh: last.speed_kmh,
                at: last.at
              });
            }
            if (typeof last?.stale_seconds === "number")
              setStaleSeconds(last.stale_seconds);
            if (last?.status) setTripStatus(last.status);

            const px = await call<{ passengers: PassengerPin[] }>(
              "rideshare.api.tracking.get_passenger_locations",
              { ride: params.rideId }
            );
            const next: Record<string, PassengerPin> = {};
            for (const p of px.passengers || []) {
              if (p.lat != null && p.lng != null) next[p.booking] = p;
            }
            setPassengerPins(next);
          } catch {
            /* ignore */
          }
        }, POLL_INTERVAL_MS);
      }

      // 3. Start streaming our own GPS.
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(
          "Location required",
          role === "driver"
            ? "Enable location to share your position with passengers."
            : "Enable location so the driver can see where to pick you up."
        );
        return;
      }

      async function pushFix() {
        const f = myFix.current;
        if (!f) return;
        try {
          if (role === "driver") {
            await call("rideshare.api.tracking.push_location", {
              ride: params.rideId,
              lat: f.lat,
              lng: f.lng,
              heading: f.heading,
              speed_kmh: f.speed != null ? f.speed * 3.6 : undefined
            });
          } else if (bookingId) {
            await call("rideshare.api.tracking.push_passenger_location", {
              booking: bookingId,
              lat: f.lat,
              lng: f.lng,
              heading: f.heading,
              speed_kmh: f.speed != null ? f.speed * 3.6 : undefined
            });
          }
        } catch {
          /* retry next tick */
        }
      }

      watchRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.High,
          timeInterval: 3000,
          distanceInterval: 10
        },
        (pos) => {
          const isFirstFix = myFix.current == null;
          myFix.current = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            heading: pos.coords.heading,
            speed: pos.coords.speed
          };
          // Drivers see their own GPS as `driverLoc` so the map follows
          // the car immediately (don't wait for the server roundtrip).
          if (role === "driver") {
            setDriverLoc({
              ride: params.rideId,
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              heading: pos.coords.heading,
              speed_kmh: pos.coords.speed ? pos.coords.speed * 3.6 : null,
              at: new Date().toISOString()
            });
          } else if (bookingId) {
            // Passengers see their own pin update locally too.
            setPassengerPins((prev) => ({
              ...prev,
              [bookingId]: {
                booking: bookingId,
                passenger: "you",
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                heading: pos.coords.heading,
                speed_kmh: pos.coords.speed ? pos.coords.speed * 3.6 : null,
                at: new Date().toISOString()
              }
            }));
          }
          setStaleSeconds(0);
          if (isFirstFix) pushFix();
        }
      );
      pushRef.current = setInterval(pushFix, PUSH_INTERVAL_MS);
      // Also refresh the route on a slow heartbeat so the ETA keeps
      // ticking down even when the driver is stuck in traffic.
      routeTimerRef.current = setInterval(refreshRoute, ROUTE_REFRESH_MS);
    }

    init();
    return () => {
      cancelled = true;
      if (unsub) unsub();
      if (watchRef.current) watchRef.current.remove();
      if (pushRef.current) clearInterval(pushRef.current);
      if (pollRef.current) clearInterval(pollRef.current);
      if (routeTimerRef.current) clearInterval(routeTimerRef.current);
    };
  }, [params.rideId, role, bookingId, refreshRoute]);

  // Recentre the camera whenever the focus pin moves significantly.
  useEffect(() => {
    if (!driverLoc || !mapRef.current) return;
    mapRef.current.animateCamera(
      {
        center: { latitude: driverLoc.lat, longitude: driverLoc.lng },
        heading: driverLoc.heading ?? 0,
        pitch: 0,
        zoom: 15
      },
      { duration: 700 }
    );
    // Only re-pan on coordinate change — full driverLoc object churns every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driverLoc?.lat, driverLoc?.lng]);

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
            await call("rideshare.api.tracking.complete_trip", {
              ride: params.rideId
            });
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

  const passengerList = useMemo(
    () => Object.values(passengerPins),
    [passengerPins]
  );

  if (!driverLoc && passengerList.length === 0) {
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
  // Centre on whichever pin actually exists.
  const cameraCentre =
    driverLoc ??
    (passengerList[0]
      ? {
          ride: params.rideId,
          lat: passengerList[0].lat,
          lng: passengerList[0].lng,
          heading: passengerList[0].heading ?? null,
          speed_kmh: passengerList[0].speed_kmh ?? null,
          at: passengerList[0].at ?? new Date().toISOString()
        }
      : null);

  return (
    <View style={s.shell}>
      <MapView
        ref={(m) => {
          mapRef.current = m;
        }}
        style={{ flex: 1 }}
        provider={PROVIDER_DEFAULT}
        showsUserLocation={false}
        showsCompass
        initialRegion={{
          latitude: cameraCentre?.lat ?? 20.5937,
          longitude: cameraCentre?.lng ?? 78.9629,
          latitudeDelta: 0.05,
          longitudeDelta: 0.05
        }}
      >
        {/* Free, open-source map tiles — no Google Maps API key required.
            For commercial-scale traffic, swap OSM_TILE_URL for a self-hosted
            tileserver-gl or a free-tier provider like OpenFreeMap. */}
        <UrlTile
          urlTemplate={OSM_TILE_URL}
          maximumZ={19}
          flipY={false}
          shouldReplaceMapContent={true}
        />

        {/* Pickup + destination pins (always rendered when we know them). */}
        {endpoints.origin?.lat ? (
          <Marker
            coordinate={{
              latitude: endpoints.origin.lat,
              longitude: endpoints.origin.lng
            }}
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

        {/* Road-snapped route from driver → destination, from OSRM. */}
        {routeInfo && routeInfo.polyline.length >= 2 ? (
          <Polyline
            coordinates={routeInfo.polyline}
            strokeColor={colors.primary}
            strokeWidth={4}
          />
        ) : endpoints.origin?.lat && endpoints.destination?.lat ? (
          <Polyline
            coordinates={[
              {
                latitude: endpoints.origin.lat,
                longitude: endpoints.origin.lng
              },
              {
                latitude: endpoints.destination.lat,
                longitude: endpoints.destination.lng
              }
            ]}
            strokeColor={colors.text}
            strokeWidth={2}
            lineDashPattern={[6, 6]}
          />
        ) : null}

        {/* Driver pin */}
        {driverLoc ? (
          <Marker
            coordinate={{
              latitude: driverLoc.lat,
              longitude: driverLoc.lng
            }}
            title={role === "driver" ? "You" : "Driver"}
            rotation={driverLoc.heading ?? 0}
            flat
            anchor={{ x: 0.5, y: 0.5 }}
          >
            <CarMarker fresh={fresh} />
          </Marker>
        ) : null}

        {/* Passenger pin(s) — one per active booking. */}
        {passengerList.map((p) => (
          <Marker
            key={p.booking}
            coordinate={{ latitude: p.lat, longitude: p.lng }}
            title={role === "driver" ? "Passenger" : "You"}
            anchor={{ x: 0.5, y: 0.5 }}
          >
            <PassengerMarker isSelf={role === "passenger" && p.booking === bookingId} />
          </Marker>
        ))}
      </MapView>

      {/* Top bar: status + back */}
      <SafeAreaView style={s.topBar} edges={["top"]} pointerEvents="box-none">
        <View style={s.topBarInner}>
          <TouchableOpacity
            onPress={() => nav.goBack()}
            style={s.topBackBtn}
            activeOpacity={0.8}
          >
            <Ionicons name="chevron-back" size={20} color={colors.text} />
          </TouchableOpacity>
          <View style={[s.statusPill, !fresh && s.statusStale]}>
            <View style={[s.dot, !fresh && { backgroundColor: colors.warn }]} />
            <Text style={s.statusText}>
              {tripStatus || "Live"}
              {!fresh && staleSeconds != null ? `  ·  ${staleSeconds}s ago` : ""}
            </Text>
          </View>
          {driverLoc?.speed_kmh != null && driverLoc.speed_kmh > 0 ? (
            <View style={s.speedPill}>
              <Text style={s.speedText}>
                {Math.round(driverLoc.speed_kmh)} km/h
              </Text>
            </View>
          ) : (
            <View style={{ width: 40 }} />
          )}
        </View>
      </SafeAreaView>

      {/* Bottom card: ETA + actions */}
      <SafeAreaView style={s.bottomBar} edges={["bottom"]} pointerEvents="box-none">
        <View style={[s.bottomCard, shadow.floating]}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ alignItems: "center" }}
          >
            <View style={s.cardCol}>
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
            {routeInfo ? (
              <View style={s.statBlock}>
                <Text style={s.statValue}>{routeInfo.eta_minutes}</Text>
                <Text style={s.statLabel}>min ETA</Text>
              </View>
            ) : null}
            {routeInfo ? (
              <View style={s.statBlock}>
                <Text style={s.statValue}>{routeInfo.distance_km}</Text>
                <Text style={s.statLabel}>km left</Text>
              </View>
            ) : null}
            <View style={s.statBlock}>
              <Text style={s.statValue}>{passengerList.length}</Text>
              <Text style={s.statLabel}>
                {passengerList.length === 1 ? "rider" : "riders"}
              </Text>
            </View>
          </ScrollView>
          {role === "driver" && tripStatus !== "InProgress" && tripStatus !== "Completed" ? (
            <TouchableOpacity
              style={s.btn}
              onPress={startTrip}
              disabled={busy}
              activeOpacity={0.85}
            >
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
        <Text style={s.attribution}>
          Map © OpenStreetMap contributors · Route © OSRM
        </Text>
      </SafeAreaView>
    </View>
  );
}

function CarMarker({ fresh }: { fresh: boolean }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1400,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true
        })
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1.8] });
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] });

  return (
    <View style={s.markerWrap}>
      <Animated.View
        style={[
          s.pulse,
          {
            transform: [{ scale }],
            opacity,
            backgroundColor: fresh ? colors.success : colors.warn
          }
        ]}
      />
      <View style={[s.driverPin, !fresh && { backgroundColor: colors.warn }]}>
        <Ionicons name="car-sport" size={20} color={colors.primaryText} />
      </View>
    </View>
  );
}

function PassengerMarker({ isSelf }: { isSelf: boolean }) {
  return (
    <View style={s.markerWrap}>
      <View
        style={[
          s.paxPin,
          isSelf
            ? { backgroundColor: colors.primary, borderColor: "#fff" }
            : { backgroundColor: colors.pickupPin, borderColor: "#fff" }
        ]}
      >
        <Ionicons name="person" size={16} color={colors.primaryText} />
      </View>
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
    marginBottom: spacing(2),
    backgroundColor: colors.card,
    borderRadius: radii.lg,
    padding: spacing(4),
    gap: 10,
    borderWidth: 1,
    borderColor: colors.border
  },
  cardCol: { paddingRight: spacing(3) },
  cardTitle: { fontSize: 15, fontWeight: "700", color: colors.text },
  cardSub: { fontSize: 12, color: colors.soft, marginTop: 2 },
  statBlock: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing(3),
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.border
  },
  statValue: { fontSize: 18, fontWeight: "800", color: colors.text },
  statLabel: { fontSize: 11, color: colors.soft, marginTop: 2 },
  btn: {
    backgroundColor: colors.primary,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 999
  },
  btnText: { color: colors.primaryText, fontWeight: "700", fontSize: 14 },
  attribution: {
    fontSize: 10,
    color: colors.mute,
    textAlign: "center",
    paddingHorizontal: spacing(4),
    paddingBottom: spacing(2)
  },

  markerWrap: { width: 64, height: 64, alignItems: "center", justifyContent: "center" },
  pulse: { position: "absolute", width: 36, height: 36, borderRadius: 18 },
  driverPin: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.text,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: "#fff",
    ...shadow.floating
  },
  paxPin: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    ...shadow.floating
  }
});
