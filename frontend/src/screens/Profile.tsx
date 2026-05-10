import React from "react";
import { View, Text, TouchableOpacity, StyleSheet, Alert } from "react-native";
import { useAuth } from "@/auth/AuthContext";
import { colors, radii, spacing } from "@/theme";

export function ProfileScreen() {
  const { user, mobileNo, profile, signOut } = useAuth();

  return (
    <View style={s.shell}>
      <View style={s.card}>
        <Text style={s.name}>{profile?.full_name ?? user}</Text>
        <Text style={s.meta}>{mobileNo}</Text>
        <Text style={s.meta}>
          Roles: {(profile?.roles || []).filter((r) => r !== "Guest").join(", ") || "Rider"}
        </Text>
        {profile?.driver_profile ? (
          <Text style={s.meta}>
            Driver status: {profile.driver_profile.verification_status}
            {profile.driver_profile.is_verified ? " · ✓ Verified" : ""}
          </Text>
        ) : (
          <Text style={s.meta}>No driver profile yet — complete it from the web app.</Text>
        )}
      </View>

      <TouchableOpacity
        style={[s.btn, { backgroundColor: colors.danger }]}
        onPress={() =>
          Alert.alert("Log out?", "You can sign in again with the same number.", [
            { text: "Cancel", style: "cancel" },
            { text: "Log out", style: "destructive", onPress: signOut }
          ])
        }
      >
        <Text style={s.btnText}>Log out</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg, padding: spacing(4) },
  card: {
    backgroundColor: colors.card, padding: spacing(4), borderRadius: radii.lg,
    borderWidth: 1, borderColor: colors.border
  },
  name: { fontSize: 20, fontWeight: "700", color: colors.text },
  meta: { color: colors.soft, marginTop: 4, fontSize: 13 },
  btn: { marginTop: spacing(4), paddingVertical: 14, borderRadius: radii.md, alignItems: "center" },
  btnText: { color: "#fff", fontWeight: "600" }
});
