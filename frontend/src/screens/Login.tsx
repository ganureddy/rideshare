import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
  ScrollView
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/auth/AuthContext";
import { colors, radii, spacing } from "@/theme";

export function LoginScreen() {
  const { signInWithPhone } = useAuth();
  const [mobile, setMobile] = useState("");
  const [busy, setBusy] = useState(false);

  // Strip every non-digit and take the last 10 digits — Indian numbers are
  // sent without country code; the backend prefixes +91 server-side.
  function normalisedPhone(): string {
    return mobile.replace(/\D/g, "").slice(-10);
  }

  async function onSubmit() {
    const phone = normalisedPhone();
    if (phone.length !== 10) {
      Alert.alert("Invalid number", "Enter a valid 10-digit mobile number.");
      return;
    }
    setBusy(true);
    try {
      await signInWithPhone(phone);
    } catch (e: any) {
      Alert.alert("Couldn't sign in", e?.message ?? "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const valid = normalisedPhone().length === 10;

  return (
    <SafeAreaView style={s.shell} edges={["top", "left", "right"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={s.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={s.brandRow}>
            <Text style={s.brand}>Rideshare</Text>
          </View>

          <Text style={s.heading}>What's your number?</Text>
          <Text style={s.sub}>
            Sign in or create an account with your phone number.
          </Text>

          <View style={s.inputRow}>
            <View style={s.country}>
              <Text style={s.countryFlag}>🇮🇳</Text>
              <Text style={s.countryCode}>+91</Text>
            </View>
            <TextInput
              style={s.input}
              value={mobile}
              onChangeText={setMobile}
              placeholder="98765 43210"
              placeholderTextColor={colors.mute}
              keyboardType="phone-pad"
              autoComplete="tel"
              autoFocus
              maxLength={15}
              inputMode="tel"
            />
          </View>

          <TouchableOpacity
            style={[s.btn, !valid && s.btnDisabled, busy && { opacity: 0.6 }]}
            onPress={onSubmit}
            disabled={busy || !valid}
            activeOpacity={0.85}
          >
            {busy ? (
              <ActivityIndicator color={colors.primaryText} />
            ) : (
              <>
                <Text style={s.btnText}>Continue</Text>
                <Ionicons name="arrow-forward" size={18} color={colors.primaryText} />
              </>
            )}
          </TouchableOpacity>

          <Text style={s.note}>
            By continuing, you agree to our{" "}
            <Text style={s.link}>Terms</Text> and{" "}
            <Text style={s.link}>Privacy Policy</Text>.
          </Text>

          <View style={s.divider}>
            <View style={s.dividerLine} />
            <Text style={s.dividerText}>secured by phone</Text>
            <View style={s.dividerLine} />
          </View>

          <View style={s.featureList}>
            <Feature icon="cash-outline" text="Save up to 75% on long-distance rides" />
            <Feature icon="shield-checkmark-outline" text="Verified drivers and live trip tracking" />
            <Feature icon="time-outline" text="Book in seconds — pay only your share" />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Feature({ icon, text }: { icon: any; text: string }) {
  return (
    <View style={s.feature}>
      <Ionicons name={icon} size={20} color={colors.text} />
      <Text style={s.featureText}>{text}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing(6), paddingBottom: spacing(10) },
  brandRow: { marginTop: spacing(4), marginBottom: spacing(10) },
  brand: { fontSize: 28, fontWeight: "800", color: colors.text, letterSpacing: -0.5 },
  heading: {
    fontSize: 28,
    fontWeight: "800",
    color: colors.text,
    letterSpacing: -0.5,
    marginBottom: 6
  },
  sub: { color: colors.soft, fontSize: 15, marginBottom: spacing(6) },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    backgroundColor: colors.bgAlt,
    overflow: "hidden"
  },
  country: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    gap: 6
  },
  countryFlag: { fontSize: 18 },
  countryCode: { color: colors.text, fontWeight: "700", fontSize: 16 },
  input: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 18,
    color: colors.text,
    fontWeight: "600"
  },
  btn: {
    marginTop: spacing(5),
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8
  },
  btnDisabled: { backgroundColor: "#9CA3AF" },
  btnText: { color: colors.primaryText, fontSize: 16, fontWeight: "700", letterSpacing: -0.2 },
  note: { marginTop: spacing(4), textAlign: "center", fontSize: 12, color: colors.soft, lineHeight: 18 },
  link: { color: colors.text, textDecorationLine: "underline" },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: spacing(8),
    marginBottom: spacing(5)
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { fontSize: 11, color: colors.mute, letterSpacing: 0.5, textTransform: "uppercase" },
  featureList: { gap: spacing(3) },
  feature: { flexDirection: "row", alignItems: "center", gap: 12 },
  featureText: { color: colors.text, fontSize: 14 }
});
