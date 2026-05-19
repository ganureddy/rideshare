// Driver-only booking management screen.
//
// Shows every Booking attached to one of the driver's published Rides
// grouped by status (Pending → Confirmed → Cancelled).  The driver can:
//   * confirm a Pending booking      → status flips to Confirmed
//   * decline a Pending booking      → 100% refund, Cancelled
//   * remove a Confirmed booking     → 100% refund, Cancelled (only
//                                      allowed before the trip is
//                                      InProgress)
//   * call / chat with any booker
//
// Lifecycle changes broadcast on `rideshare:booking` over the realtime
// socket, so newly-arrived requests show up without a manual refresh.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  RefreshControl,
  Linking
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import Ionicons from "@expo/vector-icons/Ionicons";
import { call } from "@/api/client";
import { subscribeToBookings, BookingEvent } from "@/realtime/socket";
import { colors, radii, spacing, shadow } from "@/theme";
import type { RootStackParamList } from "@/navigation/RootNavigator";

type Route = RouteProp<RootStackParamList, "RideBookings">;
type Nav = NativeStackNavigationProp<RootStackParamList, "RideBookings">;

type RideRow = {
  name: string;
  status: string;
  origin_city: string;
  destination_city: string;
  departure_datetime: string;
  seats_total: number;
  seats_available: number;
  price_per_seat: number;
  instant_booking: number;
};

type BookingRow = {
  name: string;
  status: "Pending" | "Confirmed" | "Cancelled" | "Completed";
  payment_status: string;
  seats_booked: number;
  total_amount: number;
  booking_code: string;
  passenger_message?: string | null;
  booked_on: string;
  passenger: string;
  passenger_name: string;
  passenger_image?: string | null;
  passenger_mobile?: string | null;
};

type Counts = {
  pending: number;
  confirmed: number;
  cancelled: number;
  pending_seats: number;
  confirmed_seats: number;
};

type Resp = { ride: RideRow; bookings: BookingRow[]; counts: Counts };

function fmtDateTime(s?: string) {
  if (!s) return "";
  try {
    return new Date(s.replace(" ", "T")).toLocaleString([], {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return s;
  }
}

export function RideBookingsScreen() {
  const { params } = useRoute<Route>();
  const nav = useNavigation<Nav>();

  const [data, setData] = useState<Resp | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await call<Resp>("rideshare.api.bookings.list_ride_bookings", {
        ride: params.rideId
      });
      if (mountedRef.current) setData(res);
    } catch (e: any) {
      Alert.alert("Couldn't load bookings", e?.message ?? "Try again.");
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  }, [params.rideId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  useEffect(() => {
    mountedRef.current = true;
    let unsub: (() => void) | null = null;
    (async () => {
      try {
        unsub = await subscribeToBookings((evt: BookingEvent) => {
          if (evt.ride !== params.rideId) return;
          load();
        }, params.rideId);
      } catch {
        /* socket optional */
      }
    })();
    return () => {
      mountedRef.current = false;
      if (unsub) unsub();
    };
  }, [params.rideId, load]);

  const grouped = useMemo(() => {
    const out: Record<"Pending" | "Confirmed" | "Cancelled", BookingRow[]> = {
      Pending: [],
      Confirmed: [],
      Cancelled: []
    };
    for (const b of data?.bookings || []) {
      if (b.status === "Pending") out.Pending.push(b);
      else if (b.status === "Confirmed" || b.status === "Completed")
        out.Confirmed.push(b);
      else out.Cancelled.push(b);
    }
    return out;
  }, [data?.bookings]);

  async function confirm(b: BookingRow) {
    setActing(b.name);
    try {
      await call("rideshare.api.bookings.driver_confirm_booking", {
        booking: b.name
      });
      await load();
    } catch (e: any) {
      Alert.alert("Couldn't confirm", e?.message ?? "Try again.");
    } finally {
      setActing(null);
    }
  }

  function decline(b: BookingRow) {
    Alert.alert(
      "Decline this request?",
      `${b.passenger_name} will be refunded in full.`,
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Decline",
          style: "destructive",
          onPress: async () => {
            setActing(b.name);
            try {
              await call("rideshare.api.bookings.driver_cancel_booking", {
                booking: b.name,
                reason: "Driver declined the request."
              });
              await load();
            } catch (e: any) {
              Alert.alert("Couldn't decline", e?.message ?? "Try again.");
            } finally {
              setActing(null);
            }
          }
        }
      ]
    );
  }

  function remove(b: BookingRow) {
    Alert.alert(
      "Remove this rider?",
      `${b.passenger_name} will be refunded in full and freed from the ride.`,
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            setActing(b.name);
            try {
              await call("rideshare.api.bookings.driver_cancel_booking", {
                booking: b.name,
                reason: "Driver removed the rider before the trip started."
              });
              await load();
            } catch (e: any) {
              Alert.alert("Couldn't remove", e?.message ?? "Try again.");
            } finally {
              setActing(null);
            }
          }
        }
      ]
    );
  }

  async function chat(b: BookingRow) {
    try {
      const res = await call<{ thread: string }>(
        "rideshare.api.chat.start_booking_chat",
        { booking: b.name }
      );
      nav.navigate("ChatThread", { threadId: res.thread });
    } catch (e: any) {
      Alert.alert("Couldn't open chat", e?.message ?? "Try again.");
    }
  }

  function callRider(b: BookingRow) {
    if (!b.passenger_mobile) return;
    Linking.openURL(`tel:${b.passenger_mobile}`).catch(() =>
      Alert.alert("Couldn't open dialler", b.passenger_mobile || "")
    );
  }

  if (!data) {
    return (
      <SafeAreaView style={[s.shell, { alignItems: "center", justifyContent: "center" }]} edges={["top"]}>
        <ActivityIndicator color={colors.text} />
      </SafeAreaView>
    );
  }

  const { ride, counts } = data;
  const tripStarted = ride.status === "InProgress" || ride.status === "Completed";
  const totalSeats = ride.seats_total || 0;
  const filled = counts.confirmed_seats;
  const requested = counts.pending_seats;

  return (
    <SafeAreaView style={s.shell} edges={["top"]}>
      <View style={s.headerBar}>
        <TouchableOpacity onPress={() => nav.goBack()} hitSlop={12}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.h1} numberOfLines={1}>Bookings</Text>
          <Text style={s.sub} numberOfLines={1}>
            {ride.origin_city} → {ride.destination_city} · {fmtDateTime(ride.departure_datetime)}
          </Text>
        </View>
        <TouchableOpacity
          style={s.trackBtn}
          onPress={() => nav.navigate("Tracking", { rideId: ride.name, role: "driver" })}
          activeOpacity={0.85}
        >
          <Ionicons name="navigate" size={14} color={colors.primaryText} />
          <Text style={s.trackBtnText}>Track</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: spacing(4), paddingBottom: spacing(8) }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} />}
        showsVerticalScrollIndicator={false}
      >
        <View style={[s.summary, shadow.card]}>
          <View style={s.summaryCol}>
            <Text style={s.summaryValue}>{filled}/{totalSeats}</Text>
            <Text style={s.summaryLabel}>seats filled</Text>
          </View>
          <View style={s.summaryDivider} />
          <View style={s.summaryCol}>
            <Text style={[s.summaryValue, requested > 0 && { color: colors.warn }]}>
              {requested}
            </Text>
            <Text style={s.summaryLabel}>pending seats</Text>
          </View>
          <View style={s.summaryDivider} />
          <View style={s.summaryCol}>
            <Text style={s.summaryValue}>₹{Math.round(ride.price_per_seat)}</Text>
            <Text style={s.summaryLabel}>per seat</Text>
          </View>
        </View>

        {ride.instant_booking ? (
          <View style={s.banner}>
            <Ionicons name="flash" size={14} color={colors.text} />
            <Text style={s.bannerText}>
              Instant booking is on — passengers are confirmed automatically as they pay.
              Use this screen to remove or contact riders.
            </Text>
          </View>
        ) : counts.pending > 0 ? (
          <View style={[s.banner, { backgroundColor: "#FFF8E1", borderColor: "#FFE082" }]}>
            <Ionicons name="alert-circle" size={14} color={colors.warn} />
            <Text style={[s.bannerText, { color: colors.text }]}>
              {counts.pending} request{counts.pending === 1 ? "" : "s"} waiting for your decision.
            </Text>
          </View>
        ) : null}

        <Section title={`Pending (${grouped.Pending.length})`} accent="warn" />
        {grouped.Pending.length === 0 ? (
          <Empty icon="hourglass-outline" text="No pending requests right now." />
        ) : (
          grouped.Pending.map((b) => (
            <BookingCard
              key={b.name}
              b={b}
              isActing={acting === b.name}
              onChat={() => chat(b)}
              onCall={callRider}
              actions={
                <>
                  <PrimaryAction
                    label="Confirm"
                    icon="checkmark"
                    onPress={() => confirm(b)}
                    disabled={acting === b.name}
                    tone="success"
                  />
                  <SecondaryAction
                    label="Decline"
                    icon="close"
                    onPress={() => decline(b)}
                    disabled={acting === b.name}
                    tone="danger"
                  />
                </>
              }
            />
          ))
        )}

        <Section title={`Confirmed (${grouped.Confirmed.length})`} accent="success" />
        {grouped.Confirmed.length === 0 ? (
          <Empty icon="people-outline" text="No confirmed riders yet." />
        ) : (
          grouped.Confirmed.map((b) => (
            <BookingCard
              key={b.name}
              b={b}
              isActing={acting === b.name}
              onChat={() => chat(b)}
              onCall={callRider}
              actions={
                tripStarted ? (
                  <Text style={s.lockedNote}>
                    <Ionicons name="lock-closed-outline" size={11} color={colors.soft} />{" "}
                    Trip {ride.status.toLowerCase()} — riders can no longer be removed.
                  </Text>
                ) : (
                  <SecondaryAction
                    label="Remove rider"
                    icon="person-remove-outline"
                    onPress={() => remove(b)}
                    disabled={acting === b.name}
                    tone="danger"
                  />
                )
              }
            />
          ))
        )}

        {grouped.Cancelled.length > 0 ? (
          <>
            <Section title={`Cancelled (${grouped.Cancelled.length})`} accent="danger" />
            {grouped.Cancelled.map((b) => (
              <BookingCard
                key={b.name}
                b={b}
                isActing={false}
                onChat={() => chat(b)}
                onCall={callRider}
                muted
              />
            ))}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({
  title,
  accent
}: {
  title: string;
  accent?: "success" | "warn" | "danger";
}) {
  const dot =
    accent === "warn"
      ? colors.warn
      : accent === "danger"
        ? colors.danger
        : colors.success;
  return (
    <View style={s.sectionRow}>
      <View style={[s.sectionDot, { backgroundColor: dot }]} />
      <Text style={s.section}>{title}</Text>
    </View>
  );
}

function Empty({ icon, text }: { icon: any; text: string }) {
  return (
    <View style={s.empty}>
      <Ionicons name={icon} size={22} color={colors.mute} />
      <Text style={s.emptyText}>{text}</Text>
    </View>
  );
}

function BookingCard({
  b,
  isActing,
  onChat,
  onCall,
  actions,
  muted
}: {
  b: BookingRow;
  isActing: boolean;
  onChat: () => void;
  onCall: (b: BookingRow) => void;
  actions?: React.ReactNode;
  muted?: boolean;
}) {
  const initials = (b.passenger_name || "Rider")
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <View style={[s.card, shadow.card, muted && { opacity: 0.65 }]}>
      <View style={s.cardHead}>
        <View style={s.avatar}>
          <Text style={s.avatarText}>{initials}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.passengerName}>{b.passenger_name}</Text>
          <Text style={s.passengerMeta}>
            {b.seats_booked} seat{b.seats_booked === 1 ? "" : "s"} · ₹{Math.round(b.total_amount)} ·{" "}
            {b.booking_code}
          </Text>
        </View>
        <StatusChip status={b.status} />
      </View>
      {b.passenger_message ? (
        <View style={s.note}>
          <Ionicons name="chatbox-ellipses-outline" size={12} color={colors.soft} />
          <Text style={s.noteText} numberOfLines={3}>{b.passenger_message}</Text>
        </View>
      ) : null}
      <View style={s.contactRow}>
        <TouchableOpacity style={s.iconBtn} onPress={onChat} activeOpacity={0.85}>
          <Ionicons name="chatbubbles-outline" size={16} color={colors.text} />
          <Text style={s.iconBtnText}>Chat</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.iconBtn, !b.passenger_mobile && { opacity: 0.4 }]}
          onPress={() => onCall(b)}
          disabled={!b.passenger_mobile}
          activeOpacity={0.85}
        >
          <Ionicons name="call-outline" size={16} color={colors.text} />
          <Text style={s.iconBtnText}>
            {b.passenger_mobile ? "Call" : "No phone"}
          </Text>
        </TouchableOpacity>
      </View>
      {actions ? (
        <View style={s.actionRow}>
          {isActing ? (
            <View style={{ paddingVertical: 12, alignItems: "center", flex: 1 }}>
              <ActivityIndicator color={colors.text} />
            </View>
          ) : (
            actions
          )}
        </View>
      ) : null}
    </View>
  );
}

function PrimaryAction({
  label,
  icon,
  onPress,
  disabled,
  tone
}: {
  label: string;
  icon: any;
  onPress: () => void;
  disabled?: boolean;
  tone?: "success" | "danger";
}) {
  const bg = tone === "success" ? colors.success : tone === "danger" ? colors.danger : colors.primary;
  return (
    <TouchableOpacity
      style={[s.actionBtn, { backgroundColor: bg }, disabled && { opacity: 0.5 }]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.85}
    >
      <Ionicons name={icon} size={16} color={colors.primaryText} />
      <Text style={s.actionBtnText}>{label}</Text>
    </TouchableOpacity>
  );
}

function SecondaryAction({
  label,
  icon,
  onPress,
  disabled,
  tone
}: {
  label: string;
  icon: any;
  onPress: () => void;
  disabled?: boolean;
  tone?: "danger" | "default";
}) {
  const fg = tone === "danger" ? colors.danger : colors.text;
  return (
    <TouchableOpacity
      style={[s.actionBtnGhost, { borderColor: fg }, disabled && { opacity: 0.5 }]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.85}
    >
      <Ionicons name={icon} size={16} color={fg} />
      <Text style={[s.actionBtnGhostText, { color: fg }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function StatusChip({ status }: { status: string }) {
  const tone =
    status === "Confirmed" || status === "Completed"
      ? colors.success
      : status === "Cancelled"
        ? colors.danger
        : colors.warn;
  return (
    <View style={[s.chip, { backgroundColor: tone }]}>
      <Text style={s.chipText}>{status}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg },
  headerBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(2),
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card
  },
  h1: { fontSize: 17, fontWeight: "800", color: colors.text, letterSpacing: -0.2 },
  sub: { fontSize: 12, color: colors.soft, marginTop: 2 },
  trackBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999
  },
  trackBtnText: { color: colors.primaryText, fontSize: 12, fontWeight: "700" },

  summary: {
    flexDirection: "row",
    backgroundColor: colors.card,
    borderRadius: radii.lg,
    padding: spacing(4),
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center"
  },
  summaryCol: { flex: 1, alignItems: "center" },
  summaryValue: { fontSize: 22, fontWeight: "800", color: colors.text, letterSpacing: -0.4 },
  summaryLabel: { fontSize: 11, color: colors.soft, marginTop: 2 },
  summaryDivider: { width: 1, height: 32, backgroundColor: colors.border },

  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: spacing(3),
    backgroundColor: colors.bgAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  bannerText: { fontSize: 12, color: colors.text, flex: 1, lineHeight: 17 },

  sectionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: spacing(5),
    marginBottom: spacing(2),
    paddingHorizontal: 4
  },
  sectionDot: { width: 8, height: 8, borderRadius: 4 },
  section: {
    fontSize: 11,
    color: colors.soft,
    textTransform: "uppercase",
    fontWeight: "800",
    letterSpacing: 0.5
  },

  empty: {
    backgroundColor: colors.bgAlt,
    borderRadius: radii.lg,
    padding: spacing(4),
    alignItems: "center",
    gap: 4,
    flexDirection: "row",
    justifyContent: "center"
  },
  emptyText: { color: colors.soft, fontSize: 13, marginLeft: 8 },

  card: {
    backgroundColor: colors.card,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing(4),
    marginBottom: spacing(3)
  },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.text,
    alignItems: "center",
    justifyContent: "center"
  },
  avatarText: { color: colors.primaryText, fontWeight: "800", fontSize: 14 },
  passengerName: { fontSize: 15, fontWeight: "700", color: colors.text },
  passengerMeta: { fontSize: 12, color: colors.soft, marginTop: 2 },

  note: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    marginTop: spacing(3),
    paddingTop: spacing(3),
    borderTopWidth: 1,
    borderTopColor: colors.border
  },
  noteText: { flex: 1, fontSize: 13, color: colors.text, lineHeight: 18 },

  contactRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: spacing(3)
  },
  iconBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: radii.md,
    backgroundColor: colors.bgAlt,
    borderWidth: 1,
    borderColor: colors.border
  },
  iconBtnText: { color: colors.text, fontSize: 13, fontWeight: "700" },

  actionRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: spacing(3)
  },
  actionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: 999
  },
  actionBtnText: { color: colors.primaryText, fontSize: 14, fontWeight: "700" },
  actionBtnGhost: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: 999,
    borderWidth: 1.5,
    backgroundColor: colors.card
  },
  actionBtnGhostText: { fontSize: 14, fontWeight: "700" },

  lockedNote: { flex: 1, fontSize: 11, color: colors.soft, paddingVertical: 6 },

  chip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  chipText: { color: colors.primaryText, fontSize: 11, fontWeight: "700" }
});
