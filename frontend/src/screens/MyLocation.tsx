// Live "where am I?" screen.
//
// Asks for foreground GPS once, fetches the device coordinate, and runs
// the backend's OpenCage reverse-geocode to pull a full address
// breakdown.  The map itself is a Leaflet + OpenStreetMap HTML page
// embedded via react-native-webview — everything ships in-bundle so the
// page works offline (after tile cache) and never leaks the OpenCage API
// key to the device.
//
// The screen is reachable from the Profile tab ("Show my location") and
// from the Publish auto-locate pill, and is intentionally role-agnostic:
// the marker glyph flips between a car (drivers) and a person (booker /
// rider) based on the route param.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  RefreshControl,
  Linking,
  Share,
  Platform
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { alert } from "@/components/AlertHost";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { WebView } from "react-native-webview";
import {
  liveLocationMapHtml,
  locateAndResolve,
  opencageUrl,
  ResolvedLocation
} from "@/utils/location";
import { colors, radii, spacing, shadow } from "@/theme";
import type { RootStackParamList } from "@/navigation/RootNavigator";

type Route = RouteProp<RootStackParamList, "MyLocation">;

export function MyLocationScreen() {
  const { params } = useRoute<Route>();
  const nav = useNavigation();
  const role = params?.role ?? "person";
  const accent = role === "driver" ? colors.brand : colors.brand;

  const [loc, setLoc] = useState<ResolvedLocation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await locateAndResolve();
      if (!next) {
        setError(
          "Couldn't read your location. Make sure GPS is on and Rideshare has location access in Settings."
        );
        return;
      }
      setLoc(next);
    } catch (e: any) {
      setError(e?.message ?? "Couldn't read your location.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const html = useMemo(() => {
    if (!loc) return null;
    return liveLocationMapHtml(
      { lat: loc.lat, lng: loc.lng },
      {
        zoom: 16,
        address: loc.formatted || loc.address || "Your current location",
        markerKind: role === "driver" ? "car" : "person",
        accentColor: accent,
        flag: loc.flag
      }
    );
  }, [loc, role, accent]);

  function shareCoords() {
    if (!loc) return;
    const url = opencageUrl(loc.lat, loc.lng, "<your-key>");
    alert(
      "Coordinates",
      `${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}\n\nOpenCage URL pattern:\n${url}`
    );
  }

  /**
   * Build a human-friendly WhatsApp message with a tappable Google
   * Maps link.  Google Maps is universal — every WhatsApp client on
   * every Android version renders it as a rich preview that opens in
   * the user's default maps app on tap.
   */
  function buildShareMessage(l: ResolvedLocation, live: boolean) {
    const url = `https://maps.google.com/?q=${l.lat.toFixed(6)},${l.lng.toFixed(6)}`;
    const address = l.formatted || l.address || "My current location";
    const header = live ? "📍 My live location" : "📍 My location";
    const liveNote = live
      ? "\n\n(Open the link in Google Maps and tap the WhatsApp 'Live Location' option to share continuous updates.)"
      : "";
    return `${header}\n${address}\n\n${url}${liveNote}`;
  }

  /**
   * Open WhatsApp directly to its contact picker with the location
   * message pre-filled.  WhatsApp handles the rest:
   *   1.  user picks one or more contacts / groups
   *   2.  WhatsApp opens the conversation with our message in the
   *       composer, complete with a Google Maps preview
   *   3.  user taps "Send"
   *
   * Implementation note — we deliberately skip `Linking.canOpenURL`
   * on Android.  Android 11+ requires a `<queries>` manifest entry
   * for canOpenURL to return true even when the target app is
   * installed, but `Linking.openURL` itself is allowed to fire
   * implicit intents without any manifest declaration.  So we just
   * try `openURL`, catch the throw if WhatsApp is missing, and fall
   * through to `wa.me` (handled by the browser) → system share
   * sheet.  This works on every Android version we support.
   */
  async function shareToWhatsApp(live: boolean) {
    if (!loc) return;
    const message = buildShareMessage(loc, live);
    const encoded = encodeURIComponent(message);

    // Direct scheme — opens WhatsApp's contact picker on Android,
    // and on iOS too (when WhatsApp's URL handler is registered).
    try {
      await Linking.openURL(`whatsapp://send?text=${encoded}`);
      return;
    } catch {/* fall through */}

    // Universal wa.me URL — handled by the browser, then bounced
    // into WhatsApp.  Works without the WhatsApp app being the
    // default handler for the whatsapp:// scheme.
    try {
      await Linking.openURL(`https://wa.me/?text=${encoded}`);
      return;
    } catch {/* fall through */}

    // Final fallback: system share sheet — lets the user pick any
    // messenger if WhatsApp is uninstalled or the URL handler is
    // disabled.
    try {
      await Share.share({
        message,
        title: live ? "My live location" : "My current location"
      });
    } catch {
      alert(
        "Can't open WhatsApp",
        Platform.OS === "android"
          ? "Install WhatsApp from the Play Store, then try again."
          : "Install WhatsApp from the App Store, then try again."
      );
    }
  }

  return (
    <SafeAreaView style={s.shell} edges={["top"]}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => nav.goBack()} hitSlop={12}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.title}>My location</Text>
          <Text style={s.subtitle} numberOfLines={1}>
            {role === "driver" ? "Driver view" : "Rider view"} · OpenStreetMap +
            OpenCage
          </Text>
        </View>
        <TouchableOpacity
          style={s.refreshBtn}
          onPress={refresh}
          disabled={busy}
          activeOpacity={0.85}
        >
          {busy ? (
            <ActivityIndicator color={colors.text} size="small" />
          ) : (
            <Ionicons name="refresh" size={18} color={colors.text} />
          )}
        </TouchableOpacity>
      </View>

      <View style={s.mapWrap}>
        {html ? (
          <>
            <WebView
              originWhitelist={["*"]}
              source={{ html }}
              style={{ flex: 1, backgroundColor: colors.bgAlt }}
              javaScriptEnabled
              domStorageEnabled
              onLoadEnd={() => setMapReady(true)}
              onMessage={(e) => {
                try {
                  const data = JSON.parse(e.nativeEvent.data);
                  if (data?.type === "ready") setMapReady(true);
                } catch {/* ignore */}
              }}
              setSupportMultipleWindows={false}
              androidLayerType="hardware"
            />
            {!mapReady ? (
              <View style={s.mapOverlay}>
                <ActivityIndicator color={colors.text} />
                <Text style={s.mapOverlayText}>Loading map…</Text>
              </View>
            ) : null}
          </>
        ) : busy ? (
          <View style={s.mapOverlay}>
            <ActivityIndicator color={colors.text} />
            <Text style={s.mapOverlayText}>Locating you…</Text>
          </View>
        ) : (
          <View style={s.mapOverlay}>
            <Ionicons name="location-outline" size={28} color={colors.mute} />
            <Text style={s.mapOverlayText}>
              {error || "Tap retry once you've allowed location access."}
            </Text>
            <TouchableOpacity style={s.retryBtn} onPress={refresh} activeOpacity={0.85}>
              <Text style={s.retryBtnText}>Try again</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      <ScrollView
        style={s.detailScroll}
        contentContainerStyle={{ padding: spacing(4), paddingBottom: spacing(8) }}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={refresh} />}
        showsVerticalScrollIndicator={false}
      >
        {loc ? (
          <>
            <View style={[s.card, shadow.card]}>
              <View style={s.addrRow}>
                <Text style={s.flag}>{loc.flag || "📍"}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.addrTitle}>
                    {loc.formatted || loc.address || "Your location"}
                  </Text>
                  <TouchableOpacity onPress={shareCoords} activeOpacity={0.7}>
                    <Text style={s.coords}>
                      {loc.lat.toFixed(6)}, {loc.lng.toFixed(6)}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Share row — WhatsApp first (primary action),
                  then a secondary "Share live" pill, and finally
                  a system share sheet for any other app. */}
              <View style={s.shareRow}>
                <TouchableOpacity
                  style={[s.shareBtn, s.shareBtnWa]}
                  onPress={() => shareToWhatsApp(false)}
                  activeOpacity={0.85}
                >
                  <Ionicons name="logo-whatsapp" size={18} color="#FFFFFF" />
                  <Text style={s.shareBtnText}>Share to WhatsApp</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.shareIconBtn}
                  onPress={() => shareToWhatsApp(true)}
                  activeOpacity={0.85}
                  accessibilityLabel="Share live location"
                >
                  <Ionicons name="radio-outline" size={18} color={colors.text} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.shareIconBtn}
                  onPress={async () => {
                    if (!loc) return;
                    try {
                      await Share.share({
                        message: buildShareMessage(loc, false),
                        title: "My current location"
                      });
                    } catch {/* user cancelled */}
                  }}
                  activeOpacity={0.85}
                  accessibilityLabel="Share to another app"
                >
                  <Ionicons name="share-social-outline" size={18} color={colors.text} />
                </TouchableOpacity>
              </View>
            </View>

            <Text style={s.section}>Address breakdown</Text>
            <View style={[s.card, shadow.card]}>
              <KV label="Road" value={loc.road} />
              <KV label="Suburb" value={loc.suburb} />
              <KV label="City" value={loc.city} />
              <KV label="District" value={loc.state_district} />
              <KV label="State" value={loc.state} accessory={loc.state_code || undefined} />
              <KV label="Postcode" value={loc.postcode} />
              <KV label="County" value={loc.county} />
              <KV label="Country" value={loc.country} accessory={loc.country_code?.toUpperCase()} />
              <KV label="Timezone" value={loc.timezone} />
              <KV label="Category" value={loc.category} accessory={loc.type || undefined} last />
            </View>

            <Text style={s.section}>Match quality</Text>
            <View style={[s.card, shadow.card]}>
              <View style={s.confRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.confLabel}>OpenCage confidence</Text>
                  <Text style={s.confSub}>0 = unknown, 10 = exact rooftop match</Text>
                </View>
                <Text style={s.confValue}>
                  {typeof loc.confidence === "number" ? loc.confidence : "—"}/10
                </Text>
              </View>
              <View style={s.confTrack}>
                <View
                  style={[
                    s.confBar,
                    {
                      width: `${Math.max(
                        0,
                        Math.min(10, loc.confidence ?? 0)
                      ) * 10}%`,
                      backgroundColor:
                        (loc.confidence ?? 0) >= 8
                          ? colors.success
                          : (loc.confidence ?? 0) >= 5
                            ? colors.warn
                            : colors.danger
                    }
                  ]}
                />
              </View>
            </View>

            <Text style={s.attribution}>
              Map © OpenStreetMap contributors · Geocoding © OpenCage
            </Text>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function KV({
  label,
  value,
  accessory,
  last
}: {
  label: string;
  value?: string | null;
  accessory?: string;
  last?: boolean;
}) {
  if (!value) return null;
  return (
    <View
      style={[
        s.kvRow,
        !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }
      ]}
    >
      <Text style={s.kvLabel}>{label}</Text>
      <View style={{ flex: 1, flexDirection: "row", justifyContent: "flex-end", gap: 6 }}>
        <Text style={s.kvValue} numberOfLines={1}>{value}</Text>
        {accessory ? <Text style={s.kvAccessory}>{accessory}</Text> : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(2),
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card
  },
  title: { fontSize: 17, fontWeight: "800", color: colors.text, letterSpacing: -0.2 },
  subtitle: { fontSize: 12, color: colors.soft, marginTop: 2 },
  refreshBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bgAlt,
    borderWidth: 1,
    borderColor: colors.border
  },

  mapWrap: {
    height: 280,
    backgroundColor: colors.bgAlt,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    position: "relative"
  },
  mapOverlay: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 24,
    backgroundColor: "rgba(255,255,255,0.92)"
  },
  mapOverlayText: { fontSize: 13, color: colors.soft, textAlign: "center" },
  retryBtn: {
    marginTop: 6,
    backgroundColor: colors.text,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 999
  },
  retryBtnText: { color: colors.primaryText, fontWeight: "700", fontSize: 13 },

  detailScroll: { flex: 1 },
  card: {
    backgroundColor: colors.card,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing(4)
  },

  addrRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  flag: { fontSize: 28 },
  addrTitle: { fontSize: 15, fontWeight: "700", color: colors.text, lineHeight: 21 },
  coords: {
    marginTop: 4,
    fontSize: 12,
    color: colors.soft,
    fontVariant: ["tabular-nums"]
  },

  shareRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: spacing(3),
    paddingTop: spacing(3),
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border
  },
  shareBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 11,
    borderRadius: radii.md
  },
  shareBtnWa: {
    backgroundColor: "#25D366"
  },
  shareBtnText: { color: "#FFFFFF", fontWeight: "700", fontSize: 14 },
  shareIconBtn: {
    width: 42,
    height: 42,
    borderRadius: radii.md,
    backgroundColor: colors.bgAlt,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center"
  },

  section: {
    fontSize: 11,
    color: colors.soft,
    textTransform: "uppercase",
    fontWeight: "800",
    letterSpacing: 0.5,
    marginTop: spacing(4),
    marginBottom: spacing(2),
    paddingHorizontal: 4
  },

  kvRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    gap: 10
  },
  kvLabel: { width: 96, color: colors.soft, fontSize: 12, fontWeight: "600" },
  kvValue: { color: colors.text, fontSize: 13, fontWeight: "600" },
  kvAccessory: {
    color: colors.soft,
    fontSize: 11,
    fontWeight: "700",
    backgroundColor: colors.bgAlt,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6
  },

  confRow: { flexDirection: "row", alignItems: "center" },
  confLabel: { color: colors.text, fontSize: 13, fontWeight: "700" },
  confSub: { color: colors.soft, fontSize: 11, marginTop: 2 },
  confValue: { color: colors.text, fontSize: 16, fontWeight: "800" },
  confTrack: {
    marginTop: 10,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.bgAlt,
    overflow: "hidden"
  },
  confBar: { height: "100%", borderRadius: 3 },

  attribution: {
    textAlign: "center",
    color: colors.mute,
    fontSize: 10,
    marginTop: spacing(4)
  }
});
