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
  Alert
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "@/auth/AuthContext";
import { colors, radii, spacing } from "@/theme";

export function LoginScreen() {
  const { signInWithPhone } = useAuth();
  const [mobile, setMobile] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    if (mobile.replace(/\D/g, "").length < 10) {
      Alert.alert("Enter a valid mobile number.");
      return;
    }
    setBusy(true);
    try {
      await signInWithPhone(mobile, name || undefined);
    } catch (e: any) {
      Alert.alert("Login failed", e?.message ?? "Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={s.shell}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1, justifyContent: "center", padding: spacing(6) }}
      >
        <Text style={s.brand}>Rideshare</Text>
        <Text style={s.sub}>Sign in with your phone number — no password needed.</Text>

        <Text style={s.label}>Mobile number</Text>
        <TextInput
          style={s.input}
          value={mobile}
          onChangeText={setMobile}
          placeholder="+91 98765 43210"
          placeholderTextColor={colors.soft}
          keyboardType="phone-pad"
          autoComplete="tel"
        />

        <Text style={s.label}>Your name (first time only)</Text>
        <TextInput
          style={s.input}
          value={name}
          onChangeText={setName}
          placeholder="e.g. Ganesh"
          placeholderTextColor={colors.soft}
        />

        <TouchableOpacity style={[s.btn, busy && { opacity: 0.6 }]} onPress={onSubmit} disabled={busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>Continue</Text>}
        </TouchableOpacity>

        <Text style={s.foot}>By continuing you accept the Terms &amp; Privacy Policy.</Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg },
  brand: { fontSize: 32, fontWeight: "700", color: colors.blue, marginBottom: 4 },
  sub: { color: colors.soft, fontSize: 15, marginBottom: spacing(6) },
  label: { fontSize: 12, color: colors.soft, marginTop: spacing(4), marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radii.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.text
  },
  btn: {
    marginTop: spacing(6),
    backgroundColor: colors.blue,
    borderRadius: radii.md,
    paddingVertical: 14,
    alignItems: "center"
  },
  btnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  foot: { marginTop: spacing(6), textAlign: "center", fontSize: 12, color: colors.soft }
});
