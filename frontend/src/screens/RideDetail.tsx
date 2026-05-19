import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Alert,
  Linking,
  Animated,
  Easing,
  Image,
  Modal
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import MapView, { Marker, Polyline, UrlTile, PROVIDER_DEFAULT } from "react-native-maps";
import Ionicons from "@expo/vector-icons/Ionicons";
import { call } from "@/api/client";
import { subscribeToRide, subscribeToBookings } from "@/realtime/socket";
import { locateAndResolve, ResolvedLocation } from "@/utils/location";
import { absoluteFileUrl } from "@/utils/upload";
import { colors, radii, spacing, shadow } from "@/theme";
import type { RootStackParamList } from "@/navigation/RootNavigator";

type Route = RouteProp<RootStackParamList, "RideDetail">;
type Nav = NativeStackNavigationProp<RootStackParamList, "RideDetail">;

type Summary = {
  name: string;
  driver: string;
  status: string;
  origin_city: string;
  origin_address?: string;
  origin_lat: number;
  origin_lng: number;
  destination_city: string;
  destination_address?: string;
  destination_lat: number;
  destination_lng: number;
  departure_datetime: string;
  duration_minutes: number;
  distance_km: number;
  seats_available: number;
  seats_total: number;
  price_per_seat: number;
  description?: string;
  women_only?: number;
  instant_booking?: number;
  waypoints: { city: string; lat: number; lng: number; stop_order: number }[];
  driver_display: {
    name?: string;
    image?: string | null;
    rating_avg?: number;
    rating_count?: number;
    is_verified?: boolean;
    total_trips?: number;
    bio?: string | null;
    has_license?: boolean;
    license_expiry?: string | null;
  };
  preferences?: {
    music: "Quiet" | "Some" | "Loud";
    chat: "Quiet" | "Some" | "Chatty";
    smoking_ok: boolean;
    pets_ok: boolean;
  };
  vehicle_details?: {
    name?: string;
    make?: string;
    model?: string;
    year?: number;
    color?: string;
    seats?: number;
    has_plate?: boolean;
    is_verified?: boolean;
    photos?: string[];
  };
  contacts?: {
    driver?: { name?: string; mobile_no?: string | null; can_call?: boolean };
    passengers?: {
      booking: string;
      user: string;
      name: string;
      mobile_no?: string | null;
      seats_booked: number;
    }[];
  };
  my_booking?: { name: string; status: string; payment_status: string } | null;
  am_i_driver?: boolean;
};

function fmtTime(s: string) {
  try {
    return new Date(s.replace(" ", "T")).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return s;
  }
}
function fmtDate(s: string) {
  try {
    return new Date(s.replace(" ", "T")).toLocaleDateString([], {
      weekday: "short",
      day: "numeric",
      month: "short"
    });
  } catch {
    return "";
  }
}
function fmtRelative(s?: string) {
  if (!s) return "just now";
  try {
    const ms = Date.now() - new Date(s.replace(" ", "T")).getTime();
    const sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 30) return "just now";
    if (sec < 90) return "1 min ago";
    const min = Math.round(sec / 60);
    if (min < 60) return `${min} min ago`;
    const hrs = Math.round(min / 60);
    return `${hrs} hr ago`;
  } catch {
    return "moments ago";
  }
}

type LiveLoc = {
  lat: number;
  lng: number;
  heading?: number | null;
  at?: string;
} | null;

type BookerLoc = ResolvedLocation | null;

export function RideDetailScreen() {
  const { params } = useRoute<Route>();
  const nav = useNavigation<Nav>();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [liveLoc, setLiveLoc] = useState<LiveLoc>(null);
  const [bookerLoc, setBookerLoc] = useState<BookerLoc>(null);
  const [pendingCount, setPendingCount] = useState<number>(0);

  async function load() {
    try {
      const s = await call<Summary>("rideshare.api.mobile.ride_summary", {
        ride: params.rideId
      });
      setSummary(s);
    } catch (e: any) {
      Alert.alert("Could not load ride", e.message);
    }
  }

  useEffect(() => {
    load();
    // `load` is a stable closure over params.rideId; tracking the id alone is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.rideId]);

  // Booker / driver location auto-fetch.  Both flows benefit:
  //   * Booker (anyone but the driver) gets a pickup pin so they can sanity
  //     check distance to origin before confirming the seat.
  //   * Driver sees their own current position next to the publish point
  //     (helpful when they're already on the road and need to verify the
  //     ride pickup is still where they think it is).
  // The reverse-geocode hits the backend's OpenCage proxy, so the API key
  // never ships in the bundle.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const loc = await locateAndResolve();
      if (cancelled || !loc) return;
      setBookerLoc(loc);
    })();
    return () => {
      cancelled = true;
    };
  }, [params.rideId]);

  // For the driver, fetch the live pending-request count so the
  // "Manage bookings" button can surface an alert badge.
  useEffect(() => {
    if (!summary?.am_i_driver) return;
    let cancelled = false;
    async function refresh() {
      try {
        const r = await call<{ counts?: { pending: number } }>(
          "rideshare.api.bookings.list_ride_bookings",
          { ride: params.rideId }
        );
        if (!cancelled) setPendingCount(r?.counts?.pending ?? 0);
      } catch {
        /* ignore */
      }
    }
    refresh();
    return () => {
      cancelled = true;
    };
  }, [summary?.am_i_driver, params.rideId]);

  // React to booking lifecycle changes pushed by the backend so the screen
  // updates without the user having to pull-to-refresh.
  useEffect(() => {
    let unsub: (() => void) | null = null;
    (async () => {
      try {
        unsub = await subscribeToBookings((evt) => {
          if (evt.ride !== params.rideId) return;
          load();
          if (summary?.am_i_driver) {
            // Pending count almost certainly changed.
            call<{ counts?: { pending: number } }>(
              "rideshare.api.bookings.list_ride_bookings",
              { ride: params.rideId }
            )
              .then((r) => setPendingCount(r?.counts?.pending ?? 0))
              .catch(() => {});
          }
        }, params.rideId);
      } catch {
        /* socket optional */
      }
    })();
    return () => {
      if (unsub) unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.rideId, summary?.am_i_driver]);

  // Live driver location: shown to a confirmed booker (or the driver
  // themselves) when the ride is moving.  Polls every 30s as a backup
  // for the realtime socket.
  useEffect(() => {
    if (!summary) return;
    const canTrack =
      summary.am_i_driver
      || (summary.my_booking?.status === "Confirmed"
        && (summary.status === "InProgress" || summary.status === "Published"));
    if (!canTrack) return;

    let unsub: (() => void) | null = null;
    let cancelled = false;
    let pollId: ReturnType<typeof setInterval> | null = null;

    async function fetchLast() {
      try {
        const last = await call<any>("rideshare.api.tracking.get_last_location", {
          ride: params.rideId
        });
        if (cancelled) return;
        if (last?.available) {
          setLiveLoc({ lat: last.lat, lng: last.lng, heading: last.heading, at: last.at });
        }
      } catch {/* ignore */}
    }

    fetchLast();
    pollId = setInterval(fetchLast, 30_000);

    (async () => {
      try {
        unsub = await subscribeToRide(params.rideId, (l) => {
          if (cancelled) return;
          setLiveLoc({ lat: l.lat, lng: l.lng, heading: l.heading, at: l.at });
        });
      } catch {/* socket optional */}
    })();

    return () => {
      cancelled = true;
      if (pollId) clearInterval(pollId);
      if (unsub) unsub();
    };
  }, [summary, params.rideId]);

  async function book() {
    if (!summary) return;
    if (busy) return;
    setBusy(true);
    try {
      const order = await call<{
        booking?: string;
        amount?: number;
        currency?: string;
        gateway?: string;
        order_id?: string;
        is_demo?: boolean;
        key_id?: string;
      }>("rideshare.api.bookings.create_booking", {
        ride: params.rideId,
        seats: 1
      });

      if (!order || !order.booking) {
        Alert.alert(
          "Booking failed",
          "The server didn't return a booking reference. Try again in a moment."
        );
        return;
      }

      // DEMO mode: backend gateway auto-confirms; just call confirm_payment.
      // For Razorpay, replace this block with the Razorpay checkout SDK
      // (react-native-razorpay) and pass the returned signature back.
      if (order.is_demo) {
        try {
          await call("rideshare.api.bookings.confirm_payment", {
            booking: order.booking,
            gateway_order_id: order.order_id,
            gateway_payment_id: `demo_${Date.now()}`,
            gateway_signature: "demo"
          });
        } catch (confirmErr: any) {
          Alert.alert(
            "Payment confirmation failed",
            confirmErr?.message ?? "Your booking was created but payment couldn't be confirmed."
          );
          // Don't crash — try to reload the screen so the user sees the
          // booking row in its actual state.
          try { await load(); } catch {/* ignore */}
          return;
        }
      } else {
        Alert.alert(
          "Payment required",
          "This server isn't in DEMO mode. Open Razorpay to complete payment."
        );
        return;
      }

      Alert.alert("Booked!", "We'll alert you when the driver confirms.");
      // Refresh the screen so the chat / tracking buttons appear.
      try { await load(); } catch {/* ignore */}
    } catch (e: any) {
      Alert.alert("Booking failed", e?.message ?? "Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function openChat() {
    if (!summary?.my_booking) return;
    try {
      const res = await call<{ thread: string }>(
        "rideshare.api.chat.start_booking_chat",
        { booking: summary.my_booking.name }
      );
      nav.navigate("ChatThread" as any, { threadId: res.thread });
    } catch (e: any) {
      Alert.alert("Couldn't open chat", e?.message ?? "Try again.");
    }
  }

  function cancelBooking() {
    if (!summary?.my_booking) return;
    const isPending = summary.my_booking.status === "Pending";
    Alert.alert(
      isPending ? "Cancel this booking?" : "Cancel your booking?",
      isPending
        ? "The driver hasn't confirmed yet — you'll get a 100% refund."
        : "A refund will be calculated based on the ride's cancellation policy.",
      [
        { text: "Keep booking", style: "cancel" },
        {
          text: "Cancel booking",
          style: "destructive",
          onPress: async () => {
            setCancelling(true);
            try {
              const res = await call<{
                refund_amount?: number;
                refund_percentage?: number;
              }>("rideshare.api.bookings.cancel_booking", {
                booking: summary.my_booking!.name
              });
              const pct = res?.refund_percentage ?? 0;
              Alert.alert(
                "Booking cancelled",
                pct >= 100
                  ? "You'll be refunded in full."
                  : pct > 0
                    ? `You'll be refunded ${pct}% (₹${Math.round(res?.refund_amount ?? 0)}).`
                    : "No refund per the ride's cancellation policy."
              );
              await load();
            } catch (e: any) {
              Alert.alert("Couldn't cancel", e?.message ?? "Try again.");
            } finally {
              setCancelling(false);
            }
          }
        }
      ]
    );
  }

  function callNumber(number?: string | null) {
    if (!number) return;
    Linking.openURL(`tel:${number}`).catch(() =>
      Alert.alert("Couldn't open dialler", number || "")
    );
  }

  if (!summary) {
    return (
      <View style={[s.shell, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator color={colors.text} />
      </View>
    );
  }

  const region = {
    latitude: (summary.origin_lat + summary.destination_lat) / 2,
    longitude: (summary.origin_lng + summary.destination_lng) / 2,
    latitudeDelta: Math.max(Math.abs(summary.origin_lat - summary.destination_lat) * 1.6, 0.5),
    longitudeDelta: Math.max(Math.abs(summary.origin_lng - summary.destination_lng) * 1.6, 0.5)
  };

  const initials = (summary.driver_display.name || "Driver")
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const alreadyBooked = !!summary.my_booking && summary.my_booking.status !== "Cancelled";
  const myBookingStatus = summary.my_booking?.status;
  const isPending = myBookingStatus === "Pending";
  const isDriver = !!summary.am_i_driver;
  const showBookerPin =
    !!bookerLoc && !isDriver && summary.status !== "Completed" && summary.status !== "Cancelled";

  let cta: {
    label: string;
    action: () => void;
    disabled?: boolean;
    icon?: any;
    badge?: number;
  } | null = null;
  if (isDriver) {
    cta = {
      label: pendingCount > 0 ? "Review requests" : "Manage bookings",
      icon: pendingCount > 0 ? "alert-circle" : "people",
      badge: pendingCount,
      action: () => nav.navigate("RideBookings", { rideId: params.rideId })
    };
  } else if (alreadyBooked) {
    if (isPending) {
      cta = {
        label: "Awaiting driver confirmation",
        icon: "hourglass",
        action: () => {},
        disabled: true
      };
    } else {
      cta = {
        label: myBookingStatus === "Confirmed" ? "Track ride" : "View booking",
        icon: "navigate",
        action: () =>
          nav.navigate("Tracking", {
            rideId: params.rideId,
            role: "passenger",
            bookingId: summary.my_booking!.name
          })
      };
    }
  } else if (summary.seats_available > 0 && summary.status === "Published") {
    cta = { label: "Book a seat", icon: "arrow-forward", action: book };
  } else {
    cta = { label: "No seats available", action: () => {}, disabled: true };
  }

  return (
    <SafeAreaView style={s.shell} edges={["bottom"]}>
      <ScrollView contentContainerStyle={{ paddingBottom: spacing(6) }} showsVerticalScrollIndicator={false}>
        <View style={s.mapWrap}>
          <MapView
            style={{ flex: 1 }}
            provider={PROVIDER_DEFAULT}
            initialRegion={region}
            pointerEvents="none"
          >
            {/* Free OpenStreetMap tiles — no Google Maps API key required. */}
            <UrlTile
              urlTemplate="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
              maximumZ={19}
              flipY={false}
              shouldReplaceMapContent={true}
            />
            <Marker
              coordinate={{ latitude: summary.origin_lat, longitude: summary.origin_lng }}
              title={summary.origin_city}
              pinColor={colors.pickupPin}
            />
            <Marker
              coordinate={{ latitude: summary.destination_lat, longitude: summary.destination_lng }}
              title={summary.destination_city}
              pinColor={colors.dropoffPin}
            />
            <Polyline
              coordinates={[
                { latitude: summary.origin_lat, longitude: summary.origin_lng },
                ...summary.waypoints
                  .filter((w) => w.lat && w.lng)
                  .map((w) => ({ latitude: w.lat, longitude: w.lng })),
                { latitude: summary.destination_lat, longitude: summary.destination_lng }
              ]}
              strokeColor={colors.text}
              strokeWidth={3}
            />
            {liveLoc ? (
              <Marker
                coordinate={{ latitude: liveLoc.lat, longitude: liveLoc.lng }}
                rotation={liveLoc.heading ?? 0}
                flat
                anchor={{ x: 0.5, y: 0.5 }}
                title={summary.am_i_driver ? "You" : "Driver"}
              >
                <CarPin />
              </Marker>
            ) : null}
            {showBookerPin ? (
              <Marker
                coordinate={{ latitude: bookerLoc!.lat, longitude: bookerLoc!.lng }}
                title={isDriver ? "You" : "Your location"}
                description={bookerLoc!.address ?? undefined}
                anchor={{ x: 0.5, y: 0.5 }}
              >
                <BookerPin />
              </Marker>
            ) : null}
          </MapView>

          {liveLoc ? (
            <View style={s.livePill}>
              <View style={s.liveDot} />
              <Text style={s.liveText}>
                Live · updated {fmtRelative(liveLoc.at)}
              </Text>
            </View>
          ) : null}

          {showBookerPin ? (
            <TouchableOpacity
              style={s.youPill}
              onPress={() =>
                nav.navigate("MyLocation", { role: isDriver ? "driver" : "person" })
              }
              activeOpacity={0.85}
            >
              <Ionicons name="locate" size={11} color={colors.primaryText} />
              <Text style={s.youPillText} numberOfLines={1}>
                You · {bookerLoc!.area || bookerLoc!.city || bookerLoc!.address || "current location"}
              </Text>
              <Ionicons name="chevron-forward" size={12} color={colors.primaryText} />
            </TouchableOpacity>
          ) : null}
        </View>

        {!isDriver && isPending ? (
          <View style={[s.statusCard, shadow.card]}>
            <View style={s.statusIcon}>
              <Ionicons name="hourglass" size={20} color={colors.text} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.statusTitle}>Awaiting driver confirmation</Text>
              <Text style={s.statusSub}>
                Your seat is held while the driver reviews this request. You can cancel any time
                before they accept for a full refund.
              </Text>
            </View>
            <TouchableOpacity
              style={s.statusCancel}
              onPress={cancelBooking}
              disabled={cancelling}
              activeOpacity={0.85}
            >
              {cancelling ? (
                <ActivityIndicator color={colors.danger} size="small" />
              ) : (
                <>
                  <Ionicons name="close" size={14} color={colors.danger} />
                  <Text style={s.statusCancelText}>Cancel</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        ) : null}

        <View style={[s.card, shadow.card]}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
            <View style={{ flex: 1 }}>
              <Text style={s.time}>{fmtTime(summary.departure_datetime)}</Text>
              <Text style={s.date}>{fmtDate(summary.departure_datetime)}</Text>
            </View>
            <Text style={s.price}>₹{Math.round(summary.price_per_seat)}</Text>
          </View>

          <View style={s.routeRow}>
            <View style={s.routeIcons}>
              <View style={[s.routeDot, { backgroundColor: colors.pickupPin }]} />
              <View style={s.routeLine} />
              <View style={[s.routeDot, { backgroundColor: colors.dropoffPin }]} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.routeText}>{summary.origin_city}</Text>
              {summary.origin_address ? (
                <Text style={s.routeAddr} numberOfLines={1}>{summary.origin_address}</Text>
              ) : null}
              <View style={{ height: 12 }} />
              <Text style={s.routeText}>{summary.destination_city}</Text>
              {summary.destination_address ? (
                <Text style={s.routeAddr} numberOfLines={1}>{summary.destination_address}</Text>
              ) : null}
            </View>
          </View>

          <View style={s.metaRow}>
            <Meta icon="speedometer-outline" text={`${summary.distance_km} km`} />
            <Meta icon="time-outline" text={`${summary.duration_minutes} min`} />
            <Meta
              icon="people-outline"
              text={`${summary.seats_available}/${summary.seats_total} seat${summary.seats_total === 1 ? "" : "s"}`}
            />
          </View>

          {summary.women_only || summary.instant_booking ? (
            <View style={s.tags}>
              {summary.instant_booking ? <Tag icon="flash-outline" text="Instant booking" /> : null}
              {summary.women_only ? <Tag icon="female-outline" text="Women only" /> : null}
            </View>
          ) : null}
        </View>

        <View style={[s.card, shadow.card, { marginTop: spacing(3) }]}>
          <Text style={s.section}>{summary.am_i_driver ? "Publisher (you)" : "Publisher"}</Text>
          <View style={s.driverRow}>
            {(() => {
              const portrait = absoluteFileUrl(summary.driver_display.image);
              return portrait ? (
                <Image source={{ uri: portrait }} style={s.avatarImg} />
              ) : (
                <View style={s.avatar}><Text style={s.avatarText}>{initials}</Text></View>
              );
            })()}
            <View style={{ flex: 1 }}>
              <Text style={s.driverName}>
                {summary.driver_display.name || "Driver"}
                {summary.driver_display.is_verified ? "  ✓ Verified" : ""}
              </Text>
              <Text style={s.driverMeta}>
                {summary.driver_display.rating_count
                  ? `★ ${summary.driver_display.rating_avg?.toFixed(1)} (${summary.driver_display.rating_count} reviews)`
                  : "New driver"}
                {summary.driver_display.total_trips
                  ? ` · ${summary.driver_display.total_trips} trips`
                  : ""}
              </Text>
              {summary.driver_display.bio ? (
                <Text style={s.bio} numberOfLines={3}>{summary.driver_display.bio}</Text>
              ) : null}
              {summary.driver_display.has_license ? (
                <View style={s.miniRow}>
                  <Ionicons name="document-text-outline" size={12} color={colors.soft} />
                  <Text style={s.miniText}>
                    Licence on file
                    {summary.driver_display.license_expiry
                      ? ` · expires ${fmtDate(summary.driver_display.license_expiry)}`
                      : ""}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>

          {/* Driver phone — visible to a confirmed booker, or to the
              driver themselves. */}
          {summary.contacts?.driver?.mobile_no ? (
            <ContactRow
              icon="call"
              title={summary.contacts.driver.name || "Publisher"}
              subtitle={summary.contacts.driver.mobile_no}
              onCall={() => callNumber(summary.contacts!.driver!.mobile_no)}
            />
          ) : !summary.am_i_driver && summary.my_booking?.status !== "Confirmed" ? (
            <Text style={s.lockedText}>
              <Ionicons name="lock-closed-outline" size={11} color={colors.soft} />{" "}
              Phone number unlocks once your booking is confirmed.
            </Text>
          ) : null}
        </View>

        {summary.vehicle_details?.make ? (
          <View style={[s.card, shadow.card, { marginTop: spacing(3) }]}>
            <Text style={s.section}>Car</Text>
            <View style={s.kvRow}>
              <Ionicons name="car-sport" size={20} color={colors.text} />
              <View style={{ flex: 1 }}>
                <Text style={s.kvTitle}>
                  {summary.vehicle_details.make} {summary.vehicle_details.model}
                  {summary.vehicle_details.year ? `  ·  ${summary.vehicle_details.year}` : ""}
                </Text>
                <Text style={s.kvSub}>
                  {[
                    summary.vehicle_details.color,
                    summary.vehicle_details.seats
                      ? `${summary.vehicle_details.seats} passenger seats`
                      : null,
                    summary.vehicle_details.has_plate ? "Plate on file" : null
                  ]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                  {summary.vehicle_details.is_verified ? "  ✓" : ""}
                </Text>
              </View>
            </View>
            <CarPhotoGallery photos={summary.vehicle_details.photos || []} />
          </View>
        ) : null}

        {summary.preferences ? (
          <View style={[s.card, shadow.card, { marginTop: spacing(3) }]}>
            <Text style={s.section}>Preferences</Text>
            <View style={s.prefGrid}>
              <PrefPill icon="musical-notes-outline" label="Music" value={summary.preferences.music} />
              <PrefPill icon="chatbubble-ellipses-outline" label="Chat" value={summary.preferences.chat} />
              <PrefPill
                icon="flame-outline"
                label="Smoking"
                value={summary.preferences.smoking_ok ? "OK" : "No"}
                tone={summary.preferences.smoking_ok ? "ok" : "deny"}
              />
              <PrefPill
                icon="paw-outline"
                label="Pets"
                value={summary.preferences.pets_ok ? "OK" : "No"}
                tone={summary.preferences.pets_ok ? "ok" : "deny"}
              />
            </View>
          </View>
        ) : null}

        {/* Driver-only: list of confirmed bookers with names + phones. */}
        {summary.am_i_driver && (summary.contacts?.passengers?.length ?? 0) > 0 ? (
          <View style={[s.card, shadow.card, { marginTop: spacing(3) }]}>
            <Text style={s.section}>Bookers</Text>
            {summary.contacts!.passengers!.map((p) => (
              <ContactRow
                key={p.booking}
                icon="person-circle"
                title={`${p.name}  ·  ${p.seats_booked} seat${p.seats_booked === 1 ? "" : "s"}`}
                subtitle={p.mobile_no || "Phone hidden"}
                onCall={p.mobile_no ? () => callNumber(p.mobile_no) : undefined}
              />
            ))}
          </View>
        ) : null}

        {summary.description ? (
          <View style={[s.card, shadow.card, { marginTop: spacing(3) }]}>
            <Text style={s.section}>Notes</Text>
            <Text style={s.notes}>{summary.description}</Text>
          </View>
        ) : null}

        {/* Chat shortcut visible whenever a booking exists or you are the
            driver — keeps both sides one tap away from messages. */}
        {(summary.my_booking || summary.am_i_driver) ? (
          <TouchableOpacity
            style={[s.chatBtn, shadow.card]}
            onPress={openChat}
            activeOpacity={0.85}
          >
            <Ionicons name="chatbubbles" size={18} color={colors.text} />
            <Text style={s.chatBtnText}>
              {summary.am_i_driver ? "Chat with passengers" : "Chat with driver"}
            </Text>
            <Ionicons name="chevron-forward" size={18} color={colors.soft} />
          </TouchableOpacity>
        ) : null}

        {/* Confirmed bookings retain a quiet cancel link — money returned
            per the ride's policy.  Pending bookings already show the loud
            cancel button up top. */}
        {!isDriver && alreadyBooked && !isPending && summary.status !== "Completed" ? (
          <TouchableOpacity
            style={s.cancelLink}
            onPress={cancelBooking}
            disabled={cancelling}
            activeOpacity={0.7}
          >
            {cancelling ? (
              <ActivityIndicator color={colors.danger} size="small" />
            ) : (
              <>
                <Ionicons name="close-circle-outline" size={14} color={colors.danger} />
                <Text style={s.cancelLinkText}>Cancel my booking</Text>
              </>
            )}
          </TouchableOpacity>
        ) : null}
      </ScrollView>

      <View style={s.cta}>
        <View>
          <Text style={s.ctaPrice}>₹{Math.round(summary.price_per_seat)}</Text>
          <Text style={s.ctaPriceSub}>per seat</Text>
        </View>
        <TouchableOpacity
          style={[s.cta_btn, (busy || cta.disabled) && { opacity: 0.5 }]}
          onPress={cta.action}
          disabled={busy || cta.disabled}
          activeOpacity={0.85}
        >
          {busy ? (
            <ActivityIndicator color={colors.primaryText} />
          ) : (
            <>
              <Text style={s.cta_btnText}>{cta.label}</Text>
              {cta.badge && cta.badge > 0 ? (
                <View style={s.ctaBadge}>
                  <Text style={s.ctaBadgeText}>{cta.badge}</Text>
                </View>
              ) : null}
              <Ionicons
                name={cta.icon ?? "arrow-forward"}
                size={18}
                color={colors.primaryText}
              />
            </>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function Meta({ icon, text }: { icon: any; text: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <Ionicons name={icon} size={14} color={colors.soft} />
      <Text style={{ fontSize: 12, color: colors.soft, fontWeight: "500" }}>{text}</Text>
    </View>
  );
}

function Tag({ icon, text }: { icon: any; text: string }) {
  return (
    <View style={s.tag}>
      <Ionicons name={icon} size={12} color={colors.text} />
      <Text style={s.tagText}>{text}</Text>
    </View>
  );
}

function ContactRow({
  icon,
  title,
  subtitle,
  onCall
}: {
  icon: any;
  title: string;
  subtitle: string;
  onCall?: () => void;
}) {
  return (
    <View style={s.contactRow}>
      <Ionicons name={icon} size={20} color={colors.text} />
      <View style={{ flex: 1 }}>
        <Text style={s.contactTitle} numberOfLines={1}>{title}</Text>
        <Text style={s.contactSub} numberOfLines={1}>{subtitle}</Text>
      </View>
      {onCall ? (
        <TouchableOpacity style={s.callPill} onPress={onCall} activeOpacity={0.85}>
          <Ionicons name="call" size={14} color={colors.primaryText} />
          <Text style={s.callPillText}>Call</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function CarPhotoGallery({ photos }: { photos: string[] }) {
  const urls = photos
    .map((p) => absoluteFileUrl(p))
    .filter((u): u is string => !!u);
  const [zoomed, setZoomed] = useState<string | null>(null);
  if (urls.length === 0) return null;
  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.galleryRow}
      >
        {urls.map((url, idx) => (
          <TouchableOpacity
            key={`${url}-${idx}`}
            style={s.galleryThumb}
            activeOpacity={0.85}
            onPress={() => setZoomed(url)}
          >
            <Image source={{ uri: url }} style={s.galleryThumbImg} />
          </TouchableOpacity>
        ))}
      </ScrollView>
      <Modal
        visible={!!zoomed}
        transparent
        animationType="fade"
        onRequestClose={() => setZoomed(null)}
      >
        <View style={s.zoomShell}>
          <TouchableOpacity
            style={s.zoomClose}
            onPress={() => setZoomed(null)}
            activeOpacity={0.85}
          >
            <Ionicons name="close" size={22} color={colors.primaryText} />
          </TouchableOpacity>
          {zoomed ? (
            <Image
              source={{ uri: zoomed }}
              style={s.zoomImg}
              resizeMode="contain"
            />
          ) : null}
        </View>
      </Modal>
    </>
  );
}

function BookerPin() {
  return (
    <View style={s.bookerWrap}>
      <View style={s.bookerOuter} />
      <View style={s.bookerInner}>
        <Ionicons name="person" size={12} color={colors.primaryText} />
      </View>
    </View>
  );
}

function CarPin() {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 1500,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true
      })
    );
    pulse.setValue(0);
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1.6] });
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] });

  return (
    <View style={s.markerWrap}>
      <Animated.View style={[s.pulse, { transform: [{ scale }], opacity }]} />
      <View style={s.carDot}>
        <Ionicons name="car-sport" size={18} color={colors.primaryText} />
      </View>
    </View>
  );
}

function PrefPill({
  icon,
  label,
  value,
  tone
}: {
  icon: any;
  label: string;
  value: string;
  tone?: "ok" | "deny";
}) {
  return (
    <View style={s.prefPill}>
      <Ionicons
        name={icon}
        size={14}
        color={tone === "deny" ? colors.danger : tone === "ok" ? colors.success : colors.text}
      />
      <View style={{ flex: 1 }}>
        <Text style={s.prefLabel}>{label}</Text>
        <Text style={s.prefValue}>{value}</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bgAlt },
  mapWrap: { height: 220, backgroundColor: colors.bgAlt, position: "relative" },

  livePill: {
    position: "absolute",
    top: 12,
    left: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(0,0,0,0.78)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.success
  },
  liveText: { color: "#fff", fontSize: 11, fontWeight: "700" },

  youPill: {
    position: "absolute",
    bottom: 12,
    left: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.primary,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    maxWidth: "80%"
  },
  youPillText: { color: colors.primaryText, fontSize: 11, fontWeight: "700" },

  bookerWrap: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  bookerOuter: {
    position: "absolute",
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(0,0,0,0.18)"
  },
  bookerInner: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#fff"
  },

  statusCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginHorizontal: spacing(4),
    marginTop: spacing(3),
    backgroundColor: "#FFF8E1",
    borderRadius: radii.lg,
    padding: spacing(3),
    borderWidth: 1,
    borderColor: "#FFE082"
  },
  statusIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(0,0,0,0.06)",
    alignItems: "center",
    justifyContent: "center"
  },
  statusTitle: { fontSize: 14, fontWeight: "800", color: colors.text },
  statusSub: { fontSize: 12, color: colors.text, marginTop: 2, lineHeight: 17 },
  statusCancel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1.2,
    borderColor: colors.danger,
    backgroundColor: colors.card
  },
  statusCancelText: { fontSize: 12, fontWeight: "700", color: colors.danger },

  cancelLink: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginHorizontal: spacing(4),
    marginTop: spacing(3),
    paddingVertical: 10
  },
  cancelLinkText: { color: colors.danger, fontSize: 13, fontWeight: "700" },

  markerWrap: { width: 56, height: 56, alignItems: "center", justifyContent: "center" },
  pulse: {
    position: "absolute",
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.success
  },
  carDot: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.text,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: "#fff",
    ...shadow.floating
  },
  card: {
    marginHorizontal: spacing(4),
    marginTop: spacing(3),
    backgroundColor: colors.card,
    borderRadius: radii.lg,
    padding: spacing(4),
    borderWidth: 1,
    borderColor: colors.border
  },
  time: { fontSize: 22, fontWeight: "800", color: colors.text, letterSpacing: -0.5 },
  date: { fontSize: 13, color: colors.soft, marginTop: 2 },
  price: { fontSize: 24, fontWeight: "800", color: colors.text, letterSpacing: -0.5 },

  routeRow: { flexDirection: "row", marginTop: spacing(3), gap: 12 },
  routeIcons: { width: 14, alignItems: "center", paddingTop: 6 },
  routeDot: { width: 10, height: 10, borderRadius: 5 },
  routeLine: { width: 2, flex: 1, backgroundColor: colors.borderStrong, marginVertical: 2 },
  routeText: { fontSize: 16, fontWeight: "700", color: colors.text },
  routeAddr: { fontSize: 12, color: colors.soft, marginTop: 2 },

  metaRow: { flexDirection: "row", gap: 16, marginTop: spacing(3), paddingTop: spacing(3), borderTopWidth: 1, borderTopColor: colors.border },
  tags: { flexDirection: "row", gap: 6, marginTop: spacing(2), flexWrap: "wrap" },
  tag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.bgAlt,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999
  },
  tagText: { color: colors.text, fontSize: 11, fontWeight: "700" },

  section: { fontSize: 11, color: colors.soft, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: "700", marginBottom: 8 },
  driverRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.text, alignItems: "center", justifyContent: "center" },
  avatarImg: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.bgAlt
  },
  avatarText: { color: colors.primaryText, fontSize: 16, fontWeight: "700" },
  driverName: { fontSize: 16, fontWeight: "700", color: colors.text },
  driverMeta: { fontSize: 12, color: colors.soft, marginTop: 2 },
  bio: { fontSize: 13, color: colors.text, marginTop: 6, lineHeight: 19 },
  miniRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  miniText: { fontSize: 11, color: colors.soft },

  contactRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: spacing(3),
    paddingTop: spacing(3),
    borderTopWidth: 1,
    borderTopColor: colors.border
  },
  contactTitle: { fontSize: 14, fontWeight: "700", color: colors.text },
  contactSub: { fontSize: 12, color: colors.soft, marginTop: 2 },
  callPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.success,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999
  },
  callPillText: { color: colors.primaryText, fontSize: 12, fontWeight: "700" },
  lockedText: {
    fontSize: 11,
    color: colors.soft,
    marginTop: spacing(3),
    paddingTop: spacing(3),
    borderTopWidth: 1,
    borderTopColor: colors.border
  },

  kvRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  kvTitle: { fontSize: 15, fontWeight: "700", color: colors.text },
  kvSub: { fontSize: 12, color: colors.soft, marginTop: 2 },

  prefGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  prefPill: {
    flexBasis: "48%",
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radii.md,
    backgroundColor: colors.bgAlt,
    borderWidth: 1,
    borderColor: colors.border
  },
  prefLabel: { fontSize: 10, color: colors.soft, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },
  prefValue: { fontSize: 13, color: colors.text, fontWeight: "700", marginTop: 1 },

  notes: { color: colors.text, fontSize: 14, lineHeight: 22 },

  chatBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginHorizontal: spacing(4),
    marginTop: spacing(3),
    backgroundColor: colors.card,
    borderRadius: radii.lg,
    paddingHorizontal: spacing(4),
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: colors.border
  },
  chatBtnText: { flex: 1, fontSize: 15, fontWeight: "700", color: colors.text },

  cta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing(4),
    paddingVertical: spacing(3),
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border
  },
  ctaPrice: { fontSize: 22, fontWeight: "800", color: colors.text, letterSpacing: -0.5 },
  ctaPriceSub: { fontSize: 11, color: colors.soft },
  cta_btn: {
    backgroundColor: colors.primary,
    paddingHorizontal: 22,
    paddingVertical: 14,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    gap: 6
  },
  cta_btnText: { color: colors.primaryText, fontWeight: "700", fontSize: 15, letterSpacing: -0.2 },
  ctaBadge: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: 11,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center"
  },
  ctaBadgeText: { color: colors.primaryText, fontSize: 11, fontWeight: "800" },

  galleryRow: { gap: 8, paddingTop: spacing(3), paddingRight: 4 },
  galleryThumb: {
    width: 116,
    height: 78,
    borderRadius: radii.md,
    overflow: "hidden",
    backgroundColor: colors.bgAlt,
    borderWidth: 1,
    borderColor: colors.border
  },
  galleryThumbImg: { width: 116, height: 78, resizeMode: "cover" },
  zoomShell: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.94)",
    alignItems: "center",
    justifyContent: "center"
  },
  zoomClose: {
    position: "absolute",
    top: 50,
    right: 18,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2
  },
  zoomImg: { width: "100%", height: "100%" }
});
