import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
  ActivityIndicator,
  Linking,
  Image
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useAuth } from "@/auth/AuthContext";
import { call } from "@/api/client";
import { absoluteFileUrl } from "@/utils/upload";
import { colors, radii, spacing, shadow } from "@/theme";
import type { RootStackParamList } from "@/navigation/RootNavigator";

type Nav = NativeStackNavigationProp<RootStackParamList>;

const HELPLINE_NUMBER = "+911800123456"; // Public-facing helpline; safe to dial.

export function ProfileScreen() {
  const nav = useNavigation<Nav>();
  const { user, mobileNo, profile, signOut } = useAuth();
  const [opening, setOpening] = useState(false);

  const initials = (profile?.full_name || profile?.first_name || "U")
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const isDriver = !!(profile?.is_driver || profile?.is_verified_driver);
  const verified = profile?.driver_profile?.is_verified;

  async function openHelpline() {
    setOpening(true);
    try {
      const res = await call<{ thread: string }>(
        "rideshare.api.chat.start_support_chat"
      );
      nav.navigate("ChatThread", { threadId: res.thread });
    } catch (e: any) {
      Alert.alert("Couldn't open helpline", e?.message ?? "Try again.");
    } finally {
      setOpening(false);
    }
  }

  function callHelpline() {
    Linking.openURL(`tel:${HELPLINE_NUMBER}`).catch(() =>
      Alert.alert("Couldn't open dialler", HELPLINE_NUMBER)
    );
  }

  function openHistory() {
    nav.navigate("Tabs" as any, { screen: "Trips", params: { startTab: "history" } });
  }

  function openMyLocation() {
    nav.navigate("MyLocation", { role: isDriver ? "driver" : "person" });
  }

  function openEditProfile() {
    nav.navigate("EditProfile");
  }

  const portrait = absoluteFileUrl((profile as any)?.user_image);

  return (
    <SafeAreaView style={s.shell} edges={["top"]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: spacing(8) }}>
        <Text style={s.h1}>Account</Text>

        <View style={[s.card, shadow.card]}>
          <View style={s.headerRow}>
            {portrait ? (
              <Image source={{ uri: portrait }} style={s.avatarImg} />
            ) : (
              <View style={s.avatar}>
                <Text style={s.avatarText}>{initials}</Text>
              </View>
            )}
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{profile?.full_name || profile?.first_name || "Rider"}</Text>
              <Text style={s.meta}>{mobileNo || user}</Text>
            </View>
            <TouchableOpacity
              style={s.editBtn}
              onPress={openEditProfile}
              activeOpacity={0.85}
            >
              <Ionicons name="create-outline" size={14} color={colors.text} />
              <Text style={s.editBtnText}>Edit</Text>
            </TouchableOpacity>
          </View>

          {isDriver ? (
            <View style={s.statusBlock}>
              <View style={[s.statusDot, { backgroundColor: verified ? colors.success : colors.warn }]} />
              <Text style={s.statusText}>
                Driver {verified ? "verified" : profile?.driver_profile?.verification_status || "pending"}
              </Text>
            </View>
          ) : (
            <View style={s.statusBlock}>
              <View style={[s.statusDot, { backgroundColor: colors.mute }]} />
              <Text style={s.statusText}>Rider — switch to driver from the Publish tab.</Text>
            </View>
          )}
        </View>

        <View style={[s.card, shadow.card, { marginTop: spacing(3), padding: 0 }]}>
          <Row icon="person-outline" label="Edit profile" onPress={openEditProfile} />
          <Row icon="receipt-outline" label="Booking history" onPress={openHistory} />
          <Row icon="locate-outline" label="My location on map" onPress={openMyLocation} />
          <Row icon="card-outline" label="Payment methods" onPress={() => {}} />
          <Row icon="shield-checkmark-outline" label="Privacy & safety" onPress={() => {}} last />
        </View>

        {/* Helpline lives ONLY in the Account tab. */}
        <View style={[s.helpCard, shadow.card]}>
          <View style={s.helpIcon}>
            <Ionicons name="help-buoy" size={20} color={colors.primaryText} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.helpTitle}>Help & support</Text>
            <Text style={s.helpSub}>
              Average response under 30 minutes (9–9 IST). Prefer to talk?
              Call our helpline.
            </Text>
            <View style={s.helpBtnRow}>
              <TouchableOpacity
                style={[s.helpBtn, { backgroundColor: colors.text }]}
                onPress={openHelpline}
                disabled={opening}
                activeOpacity={0.85}
              >
                {opening ? (
                  <ActivityIndicator color={colors.primaryText} size="small" />
                ) : (
                  <>
                    <Ionicons name="chatbubbles" size={14} color={colors.primaryText} />
                    <Text style={s.helpBtnText}>Chat with us</Text>
                  </>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.helpBtn, { backgroundColor: colors.success }]}
                onPress={callHelpline}
                activeOpacity={0.85}
              >
                <Ionicons name="call" size={14} color={colors.primaryText} />
                <Text style={s.helpBtnText}>Call</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>

        <TouchableOpacity
          style={s.logoutBtn}
          onPress={() =>
            Alert.alert("Log out?", "You can sign in again with the same number.", [
              { text: "Cancel", style: "cancel" },
              { text: "Log out", style: "destructive", onPress: signOut }
            ])
          }
          activeOpacity={0.85}
        >
          <Ionicons name="log-out-outline" size={18} color={colors.danger} />
          <Text style={s.logoutText}>Log out</Text>
        </TouchableOpacity>

        <Text style={s.version}>Rideshare · v0.1.0</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({
  icon,
  label,
  onPress,
  last,
  loading,
  highlight
}: {
  icon: any;
  label: string;
  onPress?: () => void;
  last?: boolean;
  loading?: boolean;
  highlight?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[s.row, !last && { borderBottomWidth: 1, borderBottomColor: colors.border }]}
      onPress={onPress}
      activeOpacity={0.7}
      disabled={loading}
    >
      <Ionicons name={icon} size={20} color={highlight ? colors.warn : colors.text} />
      <Text style={[s.rowText, highlight && { color: colors.text, fontWeight: "700" }]}>{label}</Text>
      {loading ? (
        <ActivityIndicator color={colors.mute} />
      ) : (
        <Ionicons name="chevron-forward" size={18} color={colors.mute} />
      )}
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg },
  h1: { fontSize: 26, fontWeight: "800", color: colors.text, letterSpacing: -0.4, marginBottom: spacing(4) },
  card: {
    backgroundColor: colors.card,
    borderRadius: radii.lg,
    padding: spacing(4),
    borderWidth: 1,
    borderColor: colors.border
  },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.text,
    alignItems: "center",
    justifyContent: "center"
  },
  avatarImg: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.bgAlt },
  avatarText: { color: colors.primaryText, fontSize: 20, fontWeight: "800" },
  editBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.bgAlt,
    borderWidth: 1,
    borderColor: colors.border
  },
  editBtnText: { fontSize: 12, fontWeight: "700", color: colors.text },
  name: { fontSize: 20, fontWeight: "800", color: colors.text, letterSpacing: -0.3 },
  meta: { color: colors.soft, marginTop: 2, fontSize: 14 },

  statusBlock: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: spacing(4),
    paddingTop: spacing(3),
    borderTopWidth: 1,
    borderTopColor: colors.border
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { color: colors.text, fontSize: 13, fontWeight: "500" },

  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing(4),
    paddingVertical: 16,
    gap: 12
  },
  rowText: { flex: 1, color: colors.text, fontSize: 15, fontWeight: "500" },

  logoutBtn: {
    marginTop: spacing(5),
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 16,
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.card
  },
  logoutText: { color: colors.danger, fontSize: 15, fontWeight: "700" },
  version: { textAlign: "center", color: colors.mute, fontSize: 11, marginTop: spacing(4) },

  helpCard: {
    flexDirection: "row",
    gap: 12,
    marginTop: spacing(3),
    backgroundColor: colors.card,
    borderRadius: radii.lg,
    padding: spacing(4),
    borderWidth: 1,
    borderColor: colors.border
  },
  helpIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.warn,
    alignItems: "center",
    justifyContent: "center"
  },
  helpTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  helpSub: { color: colors.soft, fontSize: 12, marginTop: 4, lineHeight: 18 },
  helpBtnRow: { flexDirection: "row", gap: 8, marginTop: spacing(3) },
  helpBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999
  },
  helpBtnText: { color: colors.primaryText, fontSize: 13, fontWeight: "700" }
});
