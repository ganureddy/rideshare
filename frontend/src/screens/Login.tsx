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
  ScrollView,
  Image
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { alert } from "@/components/AlertHost";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useAuth } from "@/auth/AuthContext";
import { colors, radii, spacing } from "@/theme";

type Step = "phone" | "name" | "email";

// Practical email regex — gates the Continue button.  Backend re-validates.
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function LoginScreen() {
  const { signInWithPhone, signInWithGoogle, checkPhone } = useAuth();

  const [step, setStep] = useState<Step>("phone");
  const [mobile, setMobile] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [normalisedMobile, setNormalisedMobile] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyGoogle, setBusyGoogle] = useState(false);

  function digitsOnly(): string {
    return mobile.replace(/\D/g, "").slice(-10);
  }

  async function continueWithPhone() {
    const phone = digitsOnly();
    if (phone.length !== 10) {
      alert("Invalid number", "Enter a valid 10-digit mobile number.");
      return;
    }
    setBusy(true);
    try {
      const { exists } = await checkPhone(phone);
      setNormalisedMobile(phone);
      if (exists) {
        // Returning user — sign straight in, no name needed.
        await signInWithPhone(phone);
        // AuthContext flips `user` and the navigator switches.
      } else {
        // New user — collect their name on the next step.
        setStep("name");
      }
    } catch (e: any) {
      alert("Couldn't continue", e?.message ?? "Try again.");
    } finally {
      setBusy(false);
    }
  }

  // Name is collected first; we then move to an optional email step.
  // We don't call the backend yet — only the final "create account"
  // tap (after the email step, with or without an address) hits
  // login_with_phone, so we don't create a User row the user might
  // bail on.
  function advanceFromName() {
    const name = fullName.trim();
    if (!name || name.length < 2) {
      alert("What should we call you?", "Enter your name to finish setting up your account.");
      return;
    }
    setStep("email");
  }

  async function finishSignup(opts: { withEmail: boolean }) {
    const name = fullName.trim();
    if (!name || name.length < 2) {
      alert("What should we call you?", "Enter your name to finish setting up your account.", undefined, { kind: "warn" });
      setStep("name");
      return;
    }
    let emailToSend: string | null = null;
    if (opts.withEmail) {
      const e = email.trim().toLowerCase();
      if (e && !EMAIL_RE.test(e)) {
        alert(
          "Check your email",
          "That doesn't look like a valid email address.",
          undefined,
          { kind: "warn" }
        );
        return;
      }
      emailToSend = e || null;
    }
    setBusy(true);
    try {
      await signInWithPhone(normalisedMobile, name, emailToSend);
    } catch (e: any) {
      alert("Couldn't sign in", e?.message ?? "Try again.", undefined, { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function loginWithGoogle() {
    setBusyGoogle(true);
    try {
      const res = await signInWithGoogle();
      if (!res.ok && res.reason && res.reason !== "Sign-in cancelled.") {
        alert("Google sign-in failed", res.reason);
      }
    } finally {
      setBusyGoogle(false);
    }
  }

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
            <View style={s.logoBubble}>
              <Image source={require("../../assets/icon.png")} style={s.logo} />
            </View>
            <Text style={s.brand}>Rideshare</Text>
          </View>

          {step === "phone" ? (
            <>
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
                  editable={!busy}
                />
              </View>

              <TouchableOpacity
                style={[
                  s.btn,
                  digitsOnly().length !== 10 && s.btnDisabled,
                  busy && { opacity: 0.6 }
                ]}
                onPress={continueWithPhone}
                disabled={busy || digitsOnly().length !== 10}
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

              <View style={s.orRow}>
                <View style={s.orLine} />
                <Text style={s.orText}>or</Text>
                <View style={s.orLine} />
              </View>

              <TouchableOpacity
                style={[s.googleBtn, busyGoogle && { opacity: 0.6 }]}
                onPress={loginWithGoogle}
                disabled={busyGoogle}
                activeOpacity={0.85}
              >
                {busyGoogle ? (
                  <ActivityIndicator color={colors.text} />
                ) : (
                  <>
                    <GoogleG />
                    <Text style={s.googleBtnText}>Continue with Google</Text>
                  </>
                )}
              </TouchableOpacity>
            </>
          ) : step === "name" ? (
            <>
              <Text style={s.heading}>Welcome aboard!</Text>
              <Text style={s.sub}>
                Looks like you're new here. What should we call you?
              </Text>

              <View style={s.phonePill}>
                <Ionicons name="call" size={14} color={colors.text} />
                <Text style={s.phonePillText}>+91 {normalisedMobile}</Text>
                <TouchableOpacity onPress={() => setStep("phone")} hitSlop={6}>
                  <Text style={s.phoneEdit}>Change</Text>
                </TouchableOpacity>
              </View>

              <Text style={s.label}>Full name</Text>
              <View style={s.inputRow}>
                <View style={[s.country, { borderRightWidth: 0, paddingRight: 8 }]}>
                  <Ionicons name="person-outline" size={18} color={colors.text} />
                </View>
                <TextInput
                  style={s.input}
                  value={fullName}
                  onChangeText={setFullName}
                  placeholder="Your full name"
                  placeholderTextColor={colors.mute}
                  autoCapitalize="words"
                  autoComplete="name"
                  autoFocus
                  editable={!busy}
                  returnKeyType="next"
                  onSubmitEditing={advanceFromName}
                />
              </View>

              <TouchableOpacity
                style={[s.btn, !fullName.trim() && s.btnDisabled, busy && { opacity: 0.6 }]}
                onPress={advanceFromName}
                disabled={busy || !fullName.trim()}
                activeOpacity={0.85}
              >
                <Text style={s.btnText}>Continue</Text>
                <Ionicons name="arrow-forward" size={18} color={colors.primaryText} />
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={s.heading}>Stay in the loop</Text>
              <Text style={s.sub}>
                Add your email for booking confirmations, trip receipts, and
                ride-confirmed notifications. You can also skip and add it later.
              </Text>

              <View style={s.phonePill}>
                <Ionicons name="call" size={14} color={colors.text} />
                <Text style={s.phonePillText}>+91 {normalisedMobile}</Text>
                <TouchableOpacity onPress={() => setStep("phone")} hitSlop={6}>
                  <Text style={s.phoneEdit}>Change</Text>
                </TouchableOpacity>
              </View>

              <Text style={s.label}>Email (optional)</Text>
              <View style={s.inputRow}>
                <View style={[s.country, { borderRightWidth: 0, paddingRight: 8 }]}>
                  <Ionicons name="mail-outline" size={18} color={colors.text} />
                </View>
                <TextInput
                  style={s.input}
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  placeholderTextColor={colors.mute}
                  autoCapitalize="none"
                  autoComplete="email"
                  autoCorrect={false}
                  keyboardType="email-address"
                  autoFocus
                  editable={!busy}
                  returnKeyType="done"
                  onSubmitEditing={() => finishSignup({ withEmail: true })}
                />
              </View>

              <TouchableOpacity
                style={[s.btn, busy && { opacity: 0.6 }]}
                onPress={() => finishSignup({ withEmail: true })}
                disabled={busy}
                activeOpacity={0.85}
              >
                {busy ? (
                  <ActivityIndicator color={colors.primaryText} />
                ) : (
                  <>
                    <Text style={s.btnText}>Create account</Text>
                    <Ionicons name="checkmark" size={18} color={colors.primaryText} />
                  </>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={s.skipBtn}
                onPress={() => finishSignup({ withEmail: false })}
                disabled={busy}
                activeOpacity={0.7}
              >
                <Text style={s.skipBtnText}>Skip for now</Text>
              </TouchableOpacity>
            </>
          )}

          <Text style={s.note}>
            By continuing, you agree to our{" "}
            <Text style={s.link}>Terms</Text> and{" "}
            <Text style={s.link}>Privacy Policy</Text>.
          </Text>

          <View style={s.divider}>
            <View style={s.dividerLine} />
            <Text style={s.dividerText}>secured by phone & google</Text>
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

function GoogleG() {
  // Inline 4-colour Google G — the standard logo per Google's brand
  // guidelines for sign-in buttons.  Implemented as composed circles +
  // an arc to avoid bundling an SVG library.
  return (
    <View style={s.gWrap}>
      <View style={[s.gQuad, { backgroundColor: "#EA4335", top: 0, left: 0 }]} />
      <View style={[s.gQuad, { backgroundColor: "#FBBC05", bottom: 0, left: 0 }]} />
      <View style={[s.gQuad, { backgroundColor: "#34A853", bottom: 0, right: 0 }]} />
      <View style={[s.gQuad, { backgroundColor: "#4285F4", top: 0, right: 0 }]} />
      <View style={s.gCenter}>
        <Text style={s.gLetter}>G</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing(6), paddingBottom: spacing(10) },
  brandRow: {
    marginTop: spacing(2),
    marginBottom: spacing(8),
    flexDirection: "row",
    alignItems: "center",
    gap: 12
  },
  logoBubble: {
    width: 44,
    height: 44,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: colors.brand
  },
  logo: { width: 44, height: 44 },
  brand: { fontSize: 24, fontWeight: "800", color: colors.text, letterSpacing: -0.4 },

  heading: {
    fontSize: 28,
    fontWeight: "800",
    color: colors.text,
    letterSpacing: -0.5,
    marginBottom: 6
  },
  sub: { color: colors.soft, fontSize: 15, marginBottom: spacing(6) },

  label: {
    fontSize: 12,
    color: colors.soft,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 6
  },

  phonePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.bgAlt,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing(4)
  },
  phonePillText: { color: colors.text, fontSize: 13, fontWeight: "700" },
  phoneEdit: { color: colors.brand, fontSize: 12, fontWeight: "700" },

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

  skipBtn: {
    marginTop: spacing(3),
    alignSelf: "center",
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: radii.pill
  },
  skipBtnText: { color: colors.soft, fontSize: 14, fontWeight: "700" },

  orRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: spacing(5),
    marginBottom: spacing(3)
  },
  orLine: { flex: 1, height: 1, backgroundColor: colors.border },
  orText: { fontSize: 11, color: colors.mute, fontWeight: "700", textTransform: "uppercase" },

  googleBtn: {
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10
  },
  googleBtnText: { color: colors.text, fontSize: 15, fontWeight: "700" },
  gWrap: {
    width: 22,
    height: 22,
    borderRadius: 11,
    overflow: "hidden",
    position: "relative"
  },
  gQuad: { position: "absolute", width: "50%", height: "50%" },
  gCenter: {
    position: "absolute",
    top: 4,
    bottom: 4,
    left: 4,
    right: 4,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8
  },
  gLetter: { fontWeight: "800", fontSize: 11, color: "#1A1A1A" },

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
