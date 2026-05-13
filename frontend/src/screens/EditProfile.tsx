// Edit-profile screen: lets the signed-in user update their full name,
// portrait and (when they're enrolled as a driver) their bio.  Phone
// number stays read-only here — the backend rejects edits because every
// row in the system keys on the User.name derived from the phone.

import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/auth/AuthContext";
import { call } from "@/api/client";
import { absoluteFileUrl, pickAndUploadImage } from "@/utils/upload";
import { colors, radii, spacing, shadow } from "@/theme";

export function EditProfileScreen() {
  const nav = useNavigation();
  const { profile, mobileNo, refreshProfile } = useAuth();

  const [fullName, setFullName] = useState(profile?.full_name || profile?.first_name || "");
  const [bio, setBio] = useState((profile?.driver_profile as any)?.bio || "");
  const [photoUrl, setPhotoUrl] = useState<string | null>(profile?.user_image || null);
  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);

  // Pull in the freshest profile in case the cached copy is stale.
  useEffect(() => {
    (async () => {
      try {
        const p = await call<{
          full_name?: string;
          first_name?: string;
          user_image?: string | null;
          driver_profile?: { bio?: string };
        }>("rideshare.api.auth.whoami");
        if (p?.full_name) setFullName((cur) => cur || p.full_name || "");
        if (p?.user_image && !photoUrl) setPhotoUrl(p.user_image);
        if (p?.driver_profile?.bio && !bio) setBio(p.driver_profile.bio);
      } catch {/* ignore */}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isDriver = !!(profile?.is_driver || profile?.is_verified_driver);
  const initials = (fullName || "U")
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  async function pickPhoto(source: "library" | "camera") {
    setPhotoBusy(true);
    try {
      const f = await pickAndUploadImage({
        source,
        allowsEditing: true,
        quality: 0.7,
        isPrivate: false
      });
      if (f?.fileUrl) setPhotoUrl(f.fileUrl);
    } catch (e: any) {
      Alert.alert("Couldn't upload", e?.message ?? "Try a different photo.");
    } finally {
      setPhotoBusy(false);
    }
  }

  function choosePhotoSource() {
    Alert.alert("Profile photo", "How would you like to add your photo?", [
      { text: "Take photo", onPress: () => pickPhoto("camera") },
      { text: "Pick from gallery", onPress: () => pickPhoto("library") },
      ...(photoUrl
        ? [{ text: "Remove", style: "destructive" as const, onPress: () => setPhotoUrl(null) }]
        : []),
      { text: "Cancel", style: "cancel" as const }
    ]);
  }

  async function save() {
    if (!fullName.trim()) {
      Alert.alert("Add a name", "Your name helps drivers and riders recognise you.");
      return;
    }
    setBusy(true);
    try {
      await call("rideshare.api.auth.update_profile", {
        full_name: fullName.trim(),
        bio: isDriver ? bio.trim() : null,
        user_image: photoUrl ?? ""
      });
      await refreshProfile();
      Alert.alert("Saved", "Your profile has been updated.");
      nav.goBack();
    } catch (e: any) {
      Alert.alert("Couldn't save", e?.message ?? "Try again.");
    } finally {
      setBusy(false);
    }
  }

  const portrait = absoluteFileUrl(photoUrl);

  return (
    <SafeAreaView style={s.shell} edges={["top"]}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => nav.goBack()} hitSlop={12}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.title}>Edit profile</Text>
        <View style={{ width: 26 }} />
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={{ padding: spacing(4), paddingBottom: spacing(8) }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={[s.card, shadow.card]}>
            <View style={s.avatarRow}>
              <TouchableOpacity
                style={s.avatarWrap}
                onPress={choosePhotoSource}
                disabled={photoBusy}
                activeOpacity={0.85}
              >
                {portrait ? (
                  <Image source={{ uri: portrait }} style={s.avatarImg} />
                ) : (
                  <View style={s.avatarPlaceholder}>
                    <Text style={s.avatarText}>{initials}</Text>
                  </View>
                )}
                <View style={s.avatarBadge}>
                  {photoBusy ? (
                    <ActivityIndicator color={colors.primaryText} size="small" />
                  ) : (
                    <Ionicons
                      name={portrait ? "camera-reverse" : "camera"}
                      size={14}
                      color={colors.primaryText}
                    />
                  )}
                </View>
              </TouchableOpacity>
              <View style={{ flex: 1 }}>
                <Text style={s.avatarTitle}>Profile photo</Text>
                <Text style={s.avatarSub}>
                  Bookers, drivers and chat threads see this avatar.
                </Text>
                <TouchableOpacity
                  style={s.avatarBtn}
                  onPress={choosePhotoSource}
                  disabled={photoBusy}
                  activeOpacity={0.85}
                >
                  <Text style={s.avatarBtnText}>
                    {portrait ? "Change photo" : "Add photo"}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>

          <View style={[s.card, shadow.card, { marginTop: spacing(3) }]}>
            <Text style={s.label}>Full name</Text>
            <TextInput
              style={s.input}
              value={fullName}
              onChangeText={setFullName}
              placeholder="Your full name"
              placeholderTextColor={colors.mute}
              autoCapitalize="words"
              autoComplete="name"
              maxLength={120}
            />

            <Text style={[s.label, { marginTop: spacing(3) }]}>Phone</Text>
            <View style={[s.input, s.readonly]}>
              <Text style={s.readonlyText}>{mobileNo || "—"}</Text>
              <Ionicons name="lock-closed-outline" size={14} color={colors.soft} />
            </View>
            <Text style={s.hint}>
              Your account is keyed on your number — contact support if you need to change it.
            </Text>

            {isDriver ? (
              <>
                <Text style={[s.label, { marginTop: spacing(3) }]}>Driver bio</Text>
                <TextInput
                  style={[s.input, { height: 96, textAlignVertical: "top" }]}
                  value={bio}
                  onChangeText={setBio}
                  placeholder="Tell passengers a bit about yourself."
                  placeholderTextColor={colors.mute}
                  multiline
                  maxLength={600}
                />
              </>
            ) : null}
          </View>

          <TouchableOpacity
            style={[s.saveBtn, busy && { opacity: 0.5 }]}
            onPress={save}
            disabled={busy}
            activeOpacity={0.85}
          >
            {busy ? (
              <ActivityIndicator color={colors.primaryText} />
            ) : (
              <>
                <Ionicons name="checkmark" size={18} color={colors.primaryText} />
                <Text style={s.saveBtnText}>Save changes</Text>
              </>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(2),
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card
  },
  title: { fontSize: 17, fontWeight: "800", color: colors.text, letterSpacing: -0.2 },

  card: {
    backgroundColor: colors.card,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing(4)
  },

  avatarRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  avatarWrap: { width: 84, height: 84, position: "relative" },
  avatarImg: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: colors.bgAlt
  },
  avatarPlaceholder: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: colors.text,
    alignItems: "center",
    justifyContent: "center"
  },
  avatarText: { color: colors.primaryText, fontSize: 26, fontWeight: "800" },
  avatarBadge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.card
  },
  avatarTitle: { fontSize: 14, fontWeight: "800", color: colors.text },
  avatarSub: { fontSize: 12, color: colors.soft, marginTop: 2, lineHeight: 17 },
  avatarBtn: {
    alignSelf: "flex-start",
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.bgAlt,
    borderWidth: 1,
    borderColor: colors.border
  },
  avatarBtnText: { fontSize: 12, fontWeight: "700", color: colors.text },

  label: {
    fontSize: 12,
    color: colors.soft,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 6
  },
  input: {
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.bgAlt,
    fontWeight: "500"
  },
  readonly: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.bg
  },
  readonlyText: { color: colors.text, fontSize: 15, fontWeight: "600" },
  hint: { color: colors.soft, fontSize: 11, marginTop: 6, lineHeight: 16 },

  saveBtn: {
    marginTop: spacing(4),
    backgroundColor: colors.primary,
    borderRadius: 999,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8
  },
  saveBtnText: { color: colors.primaryText, fontWeight: "800", fontSize: 15 }
});
