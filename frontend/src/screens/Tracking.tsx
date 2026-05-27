// Live trip map — two-way GPS tracking on free, open-source infra.
//
// Stack
// -----
//   Map tiles:    OpenStreetMap via Leaflet inside a WebView (TripMapWebView)
//                 — see commit notes: react-native-maps was crashing on the
//                 Android release builds the user was testing, so we
//                 swapped to the same WebView+Leaflet pattern that
//                 MyLocation and ChatThread already use successfully.
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

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  ScrollView
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { alert } from "@/components/AlertHost";
import * as Location from "expo-location";
import { useRoute, RouteProp, useNavigation } from "@react-navigation/native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { call } from "@/api/client";
import {
  subscribeToRide,
  RideLocation,
  PassengerLocation
} from "@/realtime/socket";
import { findPathAStar, type LatLng as AStarLatLng } from "@/utils/astar";
import { validLatLng } from "@/utils/mapSafe";
import { TripMapWebView, type TripMapState } from "@/components/TripMapWebView";
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
// Re-run the A* search whenever the driver has moved more than this.
// Keeping it lower than the OSRM threshold gives the on-screen path
// noticeable life (it's much cheaper to recompute than the OSRM trip).
const ASTAR_RECOMPUTE_DISTANCE_M = 150;

// Tile provider for the Leaflet WebView is hard-coded to
// tile.openstreetmap.org inside TripMapWebView; production deployments
// should switch to a commercial-friendly source there (OpenFreeMap,
// MapTiler free tier, or a self-hosted tileserver-gl).
//
// Stroke colour for the A*-computed polyline.  Distinct from
// `colors.primary` (used for the OSRM road route) so the on-screen
// stat block reads as a secondary, computed overlay.
const ASTAR_STROKE = "#0EA5A4"; // teal-500

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
  // A*-computed path (driver → pickup before trip starts, driver →
  // destination during the trip).  Recomputed on demand when the driver
  // moves significantly — see refreshAStar below.
  const [aStarPath, setAStarPath] = useState<{
    coords: { latitude: number; longitude: number }[];
    distanceMeters: number;
    expanded: number;
    found: boolean;
  } | null>(null);
  const lastAStarFrom = useRef<{ lat: number; lng: number } | null>(null);
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
  // A* path: driver → rider pickup (before trip is in progress) or
  // driver → ride destination (during the trip).  Pure-JS, runs on the
  // device; the produced polyline is drawn alongside the OSRM road
  // route so the user can see both the optimal-grid path and the
  // road-snapped path.
  //
  // We only recompute when:
  //   * we have a driver fix and at least one endpoint to head toward, AND
  //   * the driver has moved more than ASTAR_RECOMPUTE_DISTANCE_M since
  //     the last computation (or this is the first run).
  //
  // Goal selection:
  //   * tripStatus === "InProgress"  → drive to destination
  //   * otherwise                     → drive to pickup (origin)
  //   * if the relevant endpoint is missing, fall back to whichever is.
  // ---------------------------------------------------------------------
  const refreshAStar = useCallback(() => {
    if (!driverLoc) return;
    if (!validLatLng(driverLoc.lat, driverLoc.lng)) return;

    const tripActive = tripStatus === "InProgress";
    const candidate =
      (tripActive ? endpoints.destination : endpoints.origin) ??
      endpoints.origin ??
      endpoints.destination ??
      null;
    const goal: AStarLatLng | null =
      candidate && validLatLng(candidate.lat, candidate.lng)
        ? { lat: candidate.lat as number, lng: candidate.lng as number }
        : null;
    if (!goal) return;

    const start = { lat: driverLoc.lat, lng: driverLoc.lng };
    const lf = lastAStarFrom.current;
    if (
      lf &&
      distanceMeters(lf, start) < ASTAR_RECOMPUTE_DISTANCE_M &&
      aStarPath
    ) {
      return;
    }

    const result = findPathAStar(start, goal, {
      gridSize: 60,
      marginCells: 4
    });
    if (!result.path.length) return;
    setAStarPath({
      coords: result.path
        .filter((p) => validLatLng(p.lat, p.lng))
        .map((p) => ({ latitude: p.lat, longitude: p.lng })),
      distanceMeters: result.distanceMeters,
      expanded: result.expanded,
      found: result.found
    });
    lastAStarFrom.current = start;
  }, [driverLoc, endpoints.origin, endpoints.destination, tripStatus, aStarPath]);

  useEffect(() => {
    refreshAStar();
  }, [refreshAStar]);

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

      // 3. Start streaming our own GPS.  `requestForegroundPermissionsAsync`
      // can throw on devices where the native location module is in a
      // broken state (e.g. R8-stripped classes); wrap defensively so the
      // screen still renders the map + the existing snapshot.
      let permissionStatus: Location.PermissionStatus | "denied" = "denied";
      try {
        const result = await Location.requestForegroundPermissionsAsync();
        permissionStatus = result.status;
      } catch {
        alert(
          "Location unavailable",
          "We couldn't ask your phone for location access. Trip tracking will still show driver updates from the network."
        );
        return;
      }
      if (permissionStatus !== "granted") {
        alert(
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

      try {
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
      } catch {
        // Native watch failed (broken module, OS-level error) — without
        // this guard the unhandled rejection silently crashed the app.
        // Snapshot + socket data still drives the map.
      }
    }

    // Fire-and-forget — but with a catch so any throw inside `init()`
    // doesn't propagate as an unhandled rejection.  Hermes on Android
    // release builds will silently kill the process otherwise.
    init().catch(() => {/* errors already surfaced via Alert / state */});

    return () => {
      cancelled = true;
      try { if (unsub) unsub(); } catch {/* noop */}
      try { if (watchRef.current) watchRef.current.remove(); } catch {/* noop */}
      try { if (pushRef.current) clearInterval(pushRef.current); } catch {/* noop */}
      try { if (pollRef.current) clearInterval(pollRef.current); } catch {/* noop */}
      try { if (routeTimerRef.current) clearInterval(routeTimerRef.current); } catch {/* noop */}
    };
  }, [params.rideId, role, bookingId, refreshRoute]);

  // Camera recentring is now done inside TripMapWebView itself
  // (it pans Leaflet when the driver moves > ~80m).  No native ref
  // to drive any more.

  async function startTrip() {
    setBusy(true);
    try {
      await call("rideshare.api.tracking.start_trip", { ride: params.rideId });
      setTripStatus("InProgress");
    } catch (e: any) {
      alert("Couldn't start", e?.message ?? "Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function completeTrip() {
    alert("Complete trip?", "This will release payment after the cooldown.", [
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
            alert("Couldn't complete", e?.message ?? "Try again.");
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

  // Build the declarative state bag we hand to TripMapWebView.  All
  // coordinate validation is centralised inside that component, so we
  // can safely pass the raw values here.
  const mapState: TripMapState = {
    origin: endpoints.origin,
    destination: endpoints.destination,
    driver: driverLoc
      ? {
          lat: driverLoc.lat,
          lng: driverLoc.lng,
          heading: driverLoc.heading ?? 0,
          fresh
        }
      : null,
    passengers: passengerList
      .filter((p) => validLatLng(p.lat, p.lng))
      .map((p) => ({
        bookingId: p.booking,
        lat: p.lat,
        lng: p.lng,
        isSelf: role === "passenger" && p.booking === bookingId
      })),
    route:
      routeInfo && routeInfo.polyline.length >= 2
        ? routeInfo.polyline
            .filter((c) => validLatLng(c.latitude, c.longitude))
            .map((c) => ({ lat: c.latitude, lng: c.longitude }))
        : [],
    aStar:
      aStarPath && aStarPath.coords.length >= 2
        ? aStarPath.coords
            .filter((c) => validLatLng(c.latitude, c.longitude))
            .map((c) => ({ lat: c.latitude, lng: c.longitude }))
        : []
  };

  return (
    <View style={s.shell}>
      <TripMapWebView state={mapState} style={{ flex: 1 }} />

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
            {aStarPath ? (
              <View style={[s.statBlock, s.statBlockAStar]}>
                <Text style={[s.statValue, { color: ASTAR_STROKE }]}>
                  {(aStarPath.distanceMeters / 1000).toFixed(1)}
                </Text>
                <Text style={s.statLabel}>
                  km · A*
                </Text>
              </View>
            ) : null}
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
          Map © OpenStreetMap contributors · Route © OSRM · A* on-device
        </Text>
      </SafeAreaView>
    </View>
  );
}

// CarMarker / PassengerMarker were native-map overlay components.
// They've been replaced by div-icons inside the Leaflet WebView
// (see TripMapWebView.tsx); the React layer no longer renders any
// marker views.

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
  statBlockAStar: {
    borderLeftColor: ASTAR_STROKE
  },
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

});
