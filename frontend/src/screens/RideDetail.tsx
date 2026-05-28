import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Linking,
  Image,
  Modal
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { alert } from "@/components/AlertHost";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import Ionicons from "@expo/vector-icons/Ionicons";
import { call } from "@/api/client";
import { CarLoader } from "@/components/CarLoader";
import { ENV } from "@/env";
import { subscribeToBookings } from "@/realtime/socket";
import { absoluteFileUrl } from "@/utils/upload";
import { credentialsStore } from "@/auth/store";
import { colors, radii, spacing, shadow } from "@/theme";
import type { RootStackParamList } from "@/navigation/RootNavigator";

// NOTE: this screen used to mount a `react-native-maps` MapView and
// trigger `expo-location` for the booker's current pin.  Both native
// modules were the source of repeated silent crashes on Android
// release builds — when the OS permission dialog fired on tap-to-allow,
// the native bridge could die before any JS error boundary saw it.
//
// We've removed both from this booking-flow screen to make it 100%
// crash-resistant.  The actual live trip map (driver's GPS + the A*
// approach polyline + the OSRM road route) still lives on the
// `Tracking` screen, which is only reachable AFTER a confirmed
// booking.  RideDetail just shows a stylized non-native route preview
// here, which is plenty for the "should I book this seat?" decision.

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
export function RideDetailScreen() {
  const { params } = useRoute<Route>();
  const nav = useNavigation<Nav>();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [pendingCount, setPendingCount] = useState<number>(0);

  async function load() {
    try {
      const s = await call<Summary>("rideshare.api.mobile.ride_summary", {
        ride: params.rideId
      });
      setSummary(s);
    } catch (e: any) {
      alert("Could not load ride", e.message);
    }
  }

  useEffect(() => {
    load();
    // `load` is a stable closure over params.rideId; tracking the id alone is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.rideId]);

  // INTENTIONALLY REMOVED: the booker-location effect that called
  // `locateAndResolve()` on mount.  That triggered the OS location
  // permission dialog, and the native bridge kept dying on Android
  // release builds when the user tapped "Allow".  No location pin =
  // no permission prompt = no native crash on this screen.

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

  // INTENTIONALLY REMOVED: the live-driver-location effect that
  // polled `tracking.get_last_location` + subscribed to ride socket
  // events to plot the moving driver pin on the in-card map.  The
  // map itself is gone (see top-of-file comment), so there's nothing
  // to render the pin against.  The `Tracking` screen still does
  // this — it's reachable from the "Track ride" CTA below as soon as
  // the booking is Confirmed.

  /**
   * Book-a-seat flow (driver-confirmation only — no payment).
   *
   *   1. Tap "Book a seat" → ``create_booking(defer=1)`` lands the
   *      booking as Pending.  No gateway round-trip, no payment ever.
   *   2. The driver gets a push + email and confirms (or declines) in
   *      RideBookings.  Instant-booking rides skip step 2 — the
   *      backend auto-promotes them to Confirmed.
   *   3. Once confirmed the rider sees "Track ride" — no payment step.
   *
   * Payment gateway integration has been removed from the rider's UI;
   * backend payment endpoints still exist for any future re-enable.
   */
  function book() {
    if (!summary) return;
    if (busy) return;
    doBook();
  }

  async function doBook() {
    if (!summary) return;
    if (busy) return;
    setBusy(true);
    try {
      const order = await call<{
        booking?: string;
        booking_status?: string;
      }>("rideshare.api.bookings.create_booking", {
        ride: params.rideId,
        seats: 1,
        defer: 1
      });

      if (!order || !order.booking) {
        alert(
          "Booking failed",
          "The server didn't return a booking reference. Try again in a moment.",
          undefined,
          { kind: "error" }
        );
        return;
      }

      const confirmed = order.booking_status === "Confirmed";
      alert(
        confirmed ? "Seat confirmed!" : "Request sent!",
        confirmed
          ? "Instant booking accepted — your seat is locked in. Open chat to coordinate with the driver."
          : "We've sent your request to the driver. We'll notify you once they confirm your seat.",
        undefined,
        { kind: "success" }
      );
      try { await load(); } catch {/* ignore */}
    } catch (e: any) {
      alert("Booking failed", e?.message ?? "Try again.", undefined, { kind: "error" });
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
      alert("Couldn't open chat", e?.message ?? "Try again.");
    }
  }

  function cancelBooking() {
    if (!summary?.my_booking) return;
    const isPending = summary.my_booking.status === "Pending";
    alert(
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
              alert(
                "Booking cancelled",
                pct >= 100
                  ? "You'll be refunded in full."
                  : pct > 0
                    ? `You'll be refunded ${pct}% (₹${Math.round(res?.refund_amount ?? 0)}).`
                    : "No refund per the ride's cancellation policy."
              );
              await load();
            } catch (e: any) {
              alert("Couldn't cancel", e?.message ?? "Try again.");
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
      alert("Couldn't open dialler", number || "")
    );
  }

  // INTENTIONALLY REMOVED: the A* memo that drove the teal dashed
  // approach polyline on this screen's MapView.  The Tracking screen
  // still owns A* — see Tracking.tsx.

  if (!summary) {
    return <CarLoader label="Loading ride…" />;
  }

  // `driver_display` is optional on the Summary type; defend against
  // older backend payloads by reading it through ?. and falling back.
  const driverName = summary.driver_display?.name || "Driver";
  const initials = driverName
    .split(" ")
    .map((p) => p[0] || "")
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase() || "D";

  const alreadyBooked = !!summary.my_booking && summary.my_booking.status !== "Cancelled";
  const myBookingStatus = summary.my_booking?.status;
  const isPending = myBookingStatus === "Pending";
  const isDriver = !!summary.am_i_driver;

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

  // Stylized non-native route preview that replaces the previous
  // MapView.  Pure RN <View>s + <Text>s — never crashes, never asks
  // for location, looks polished enough for the booking decision.
  const distanceKm = Number(summary.distance_km);
  const durationMin = Number(summary.duration_minutes);
  const waypointCount = Array.isArray(summary.waypoints) ? summary.waypoints.length : 0;

  return (
    <SafeAreaView style={s.shell} edges={["bottom"]}>
      <ScrollView contentContainerStyle={{ paddingBottom: spacing(6) }} showsVerticalScrollIndicator={false}>
        {/* Route preview — pickup → (waypoints) → destination as a
            vertical timeline.  No native map, no permission prompt. */}
        <View style={s.routePreview}>
          <View style={s.routePreviewHead}>
            <Ionicons name="navigate" size={14} color={colors.primaryText} />
            <Text style={s.routePreviewHeadText}>Trip route</Text>
            {Number.isFinite(distanceKm) && distanceKm > 0 ? (
              <Text style={s.routePreviewMeta}>
                {Math.round(distanceKm)} km
                {Number.isFinite(durationMin) && durationMin > 0
                  ? ` · ${Math.round(durationMin)} min`
                  : ""}
              </Text>
            ) : null}
          </View>
          <View style={s.routePreviewBody}>
            <View style={s.routePreviewRail}>
              <View style={[s.routePreviewDot, { backgroundColor: colors.pickupPin }]} />
              <View style={s.routePreviewLine} />
              {waypointCount > 0
                ? Array.from({ length: Math.min(waypointCount, 3) }).map((_, i) => (
                    <React.Fragment key={i}>
                      <View style={[s.routePreviewDot, s.routePreviewWaypoint]} />
                      <View style={s.routePreviewLine} />
                    </React.Fragment>
                  ))
                : null}
              <View
                style={[
                  s.routePreviewDot,
                  s.routePreviewSquare,
                  { backgroundColor: colors.dropoffPin }
                ]}
              />
            </View>
            <View style={{ flex: 1, gap: spacing(2) }}>
              <View>
                <Text style={s.routePreviewCity}>{summary.origin_city || "Pickup"}</Text>
                {summary.origin_address ? (
                  <Text style={s.routePreviewAddr} numberOfLines={1}>
                    {summary.origin_address}
                  </Text>
                ) : null}
              </View>
              {waypointCount > 0
                ? (summary.waypoints || []).slice(0, 3).map((w, i) => (
                    <Text key={i} style={s.routePreviewVia} numberOfLines={1}>
                      via {w.city || "—"}
                    </Text>
                  ))
                : null}
              {waypointCount > 3 ? (
                <Text style={s.routePreviewVia}>
                  + {waypointCount - 3} more stops
                </Text>
              ) : null}
              <View>
                <Text style={s.routePreviewCity}>
                  {summary.destination_city || "Destination"}
                </Text>
                {summary.destination_address ? (
                  <Text style={s.routePreviewAddr} numberOfLines={1}>
                    {summary.destination_address}
                  </Text>
                ) : null}
              </View>
            </View>
          </View>
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
            <Text style={s.price}>₹{Math.round(Number(summary.price_per_seat) || 0)}</Text>
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
            <Meta icon="speedometer-outline" text={`${Number(summary.distance_km) || 0} km`} />
            <Meta icon="time-outline" text={`${Number(summary.duration_minutes) || 0} min`} />
            <Meta
              icon="people-outline"
              text={`${Number(summary.seats_available) || 0}/${Number(summary.seats_total) || 0} seat${Number(summary.seats_total) === 1 ? "" : "s"}`}
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
              const dd = summary.driver_display;
              const portrait = dd ? absoluteFileUrl(dd.image) : null;
              return portrait ? (
                <Image source={{ uri: portrait }} style={s.avatarImg} />
              ) : (
                <View style={s.avatar}><Text style={s.avatarText}>{initials}</Text></View>
              );
            })()}
            <View style={{ flex: 1 }}>
              <Text style={s.driverName}>
                {driverName}
                {summary.driver_display?.is_verified ? "  ✓ Verified" : ""}
              </Text>
              <Text style={s.driverMeta}>
                {(() => {
                  const ra = Number(summary.driver_display?.rating_avg);
                  const rc = Number(summary.driver_display?.rating_count);
                  const tt = Number(summary.driver_display?.total_trips);
                  const ratingPart =
                    Number.isFinite(rc) && rc > 0
                      ? `★ ${(Number.isFinite(ra) ? ra : 0).toFixed(1)} (${rc} reviews)`
                      : "New driver";
                  const tripsPart = Number.isFinite(tt) && tt > 0 ? ` · ${tt} trips` : "";
                  return `${ratingPart}${tripsPart}`;
                })()}
              </Text>
              {summary.driver_display?.bio ? (
                <Text style={s.bio} numberOfLines={3}>{summary.driver_display.bio}</Text>
              ) : null}
              {summary.driver_display?.has_license ? (
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
          <Text style={s.ctaPrice}>₹{Math.round(Number(summary.price_per_seat) || 0)}</Text>
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

      {/* Payment gateway removed — bookings go straight from rider
          → driver review → Confirmed, with no online payment step.
          The Razorpay WebView shell that used to live here was
          retired along with the Pay-Now CTA. */}
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

  // Stylized non-native route preview that replaced the MapView block.
  routePreview: {
    backgroundColor: colors.card,
    marginHorizontal: spacing(4),
    marginTop: spacing(3),
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden"
  },
  routePreviewHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.text,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(2)
  },
  routePreviewHeadText: {
    color: colors.primaryText,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.3,
    textTransform: "uppercase"
  },
  routePreviewMeta: {
    color: colors.primaryText,
    fontSize: 11,
    fontWeight: "600",
    marginLeft: "auto",
    opacity: 0.85
  },
  routePreviewBody: {
    flexDirection: "row",
    paddingHorizontal: spacing(4),
    paddingVertical: spacing(3),
    gap: spacing(3)
  },
  routePreviewRail: {
    width: 12,
    alignItems: "center",
    paddingTop: 2,
    paddingBottom: 2
  },
  routePreviewDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.text
  },
  routePreviewSquare: {
    borderRadius: 2
  },
  routePreviewWaypoint: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.borderStrong
  },
  routePreviewLine: {
    flex: 1,
    minHeight: 18,
    width: 2,
    backgroundColor: colors.borderStrong,
    marginVertical: 2
  },
  routePreviewCity: {
    fontSize: 15,
    fontWeight: "800",
    color: colors.text,
    letterSpacing: -0.2
  },
  routePreviewAddr: {
    fontSize: 12,
    color: colors.soft,
    marginTop: 2
  },
  routePreviewVia: {
    fontSize: 12,
    color: colors.soft,
    fontStyle: "italic"
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
