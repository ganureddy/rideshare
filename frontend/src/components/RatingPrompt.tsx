// Modal "rate your ride" prompt.
//
// Reusable across:
//   * Trips screen — surfaces every booking the user can review but
//     hasn't yet (pulled from rideshare.api.reviews.pending_reviews).
//   * RideDetail screen — fired right after a Confirmed → Completed
//     transition for the *current* ride.
//
// Pure RN — no native modules.  Built on the same primitives the
// rest of the app uses.

import React, { useState } from "react";
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  StyleSheet,
  Alert
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { call } from "@/api/client";
import { colors, radii, spacing, shadow } from "@/theme";

export type PendingReview = {
  booking: string;
  ride: string;
  ratee: string;
  ratee_name: string;
  origin_city: string;
  destination_city: string;
  departure_datetime: string;
  direction: "passenger_to_driver" | "driver_to_passenger";
};

const TAGS_BY_DIRECTION: Record<string, { id: string; label: string; positive: boolean }[]> = {
  passenger_to_driver: [
    { id: "punctual", label: "Punctual", positive: true },
    { id: "polite", label: "Polite", positive: true },
    { id: "safe_driving", label: "Safe driving", positive: true },
    { id: "clean_car", label: "Clean car", positive: true },
    { id: "great_music", label: "Good music", positive: true },
    { id: "late", label: "Late pickup", positive: false },
    { id: "rough_driving", label: "Rough driving", positive: false },
    { id: "messy_car", label: "Messy car", positive: false }
  ],
  driver_to_passenger: [
    { id: "punctual", label: "Punctual", positive: true },
    { id: "polite", label: "Polite", positive: true },
    { id: "tidy", label: "Tidy", positive: true },
    { id: "easy_pickup", label: "Easy pickup", positive: true },
    { id: "late", label: "Late at pickup", positive: false },
    { id: "rude", label: "Rude", positive: false },
    { id: "no_show", label: "No-show", positive: false }
  ]
};

export function RatingPromptModal({
  visible,
  pending,
  onDone,
  onSkip
}: {
  visible: boolean;
  pending: PendingReview | null;
  /** Called after a successful submit OR a "Skip for now" tap. */
  onDone: () => void;
  /** Called on dismiss without submission (back button / backdrop). */
  onSkip: () => void;
}) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // Reset on open / pending change.
  React.useEffect(() => {
    if (visible) {
      setRating(0);
      setComment("");
      setTags(new Set());
    }
  }, [visible, pending?.booking]);

  if (!pending) return null;
  const tagSet = TAGS_BY_DIRECTION[pending.direction] || TAGS_BY_DIRECTION.passenger_to_driver;
  const ratingTitle =
    rating === 0
      ? "Tap a star"
      : rating === 5
        ? "Excellent"
        : rating === 4
          ? "Good"
          : rating === 3
            ? "Okay"
            : rating === 2
              ? "Poor"
              : "Bad";

  const submit = async () => {
    if (rating < 1) {
      Alert.alert("Pick a rating", "Tap a star to rate this ride.");
      return;
    }
    setBusy(true);
    try {
      await call("rideshare.api.reviews.submit_review", {
        booking: pending.booking,
        rating,
        comment: comment.trim(),
        tags: Array.from(tags).join(",")
      });
      onDone();
    } catch (e: any) {
      Alert.alert("Couldn't submit", e?.message ?? "Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onSkip}>
      <View style={s.backdrop}>
        <View style={s.card}>
          <View style={s.head}>
            <Text style={s.heading}>How was your ride?</Text>
            <TouchableOpacity onPress={onSkip} hitSlop={10}>
              <Ionicons name="close" size={22} color={colors.soft} />
            </TouchableOpacity>
          </View>
          <Text style={s.sub} numberOfLines={2}>
            {pending.origin_city} → {pending.destination_city} ·{" "}
            {pending.direction === "passenger_to_driver" ? "rate driver" : "rate passenger"}
            {" "}<Text style={s.sub2}>{pending.ratee_name}</Text>
          </Text>

          <View style={s.starsRow}>
            {[1, 2, 3, 4, 5].map((n) => (
              <TouchableOpacity
                key={n}
                hitSlop={6}
                onPress={() => setRating(n)}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={rating >= n ? "star" : "star-outline"}
                  size={36}
                  color={rating >= n ? "#FFCB1F" : colors.borderStrong}
                  style={{ marginHorizontal: 3 }}
                />
              </TouchableOpacity>
            ))}
          </View>
          <Text style={s.ratingLabel}>{ratingTitle}</Text>

          <View style={s.tagWrap}>
            {tagSet.map((t) => {
              const active = tags.has(t.id);
              return (
                <TouchableOpacity
                  key={t.id}
                  style={[
                    s.tag,
                    active && (t.positive ? s.tagOk : s.tagBad)
                  ]}
                  onPress={() => {
                    setTags((prev) => {
                      const next = new Set(prev);
                      if (next.has(t.id)) next.delete(t.id);
                      else next.add(t.id);
                      return next;
                    });
                  }}
                  activeOpacity={0.85}
                >
                  <Text style={[s.tagText, active && s.tagTextActive]}>{t.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <TextInput
            style={s.input}
            placeholder="Add a comment (optional)"
            placeholderTextColor={colors.mute}
            value={comment}
            onChangeText={setComment}
            multiline
            maxLength={500}
          />

          <View style={s.actions}>
            <TouchableOpacity onPress={onSkip} style={s.skipBtn} activeOpacity={0.7}>
              <Text style={s.skipText}>Skip for now</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={submit}
              style={[s.submitBtn, (busy || rating < 1) && { opacity: 0.5 }]}
              disabled={busy || rating < 1}
              activeOpacity={0.85}
            >
              {busy ? (
                <ActivityIndicator color={colors.primaryText} />
              ) : (
                <Text style={s.submitText}>Submit review</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    padding: spacing(4)
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radii.lg,
    padding: spacing(4),
    ...shadow.floating
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  heading: { fontSize: 18, fontWeight: "800", color: colors.text, letterSpacing: -0.3 },
  sub: { color: colors.soft, fontSize: 13, marginTop: 4 },
  sub2: { color: colors.text, fontWeight: "700" },

  starsRow: {
    flexDirection: "row",
    justifyContent: "center",
    marginTop: spacing(4),
    marginBottom: spacing(1)
  },
  ratingLabel: {
    textAlign: "center",
    fontWeight: "700",
    color: colors.text,
    fontSize: 13,
    marginBottom: spacing(3)
  },

  tagWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: spacing(3) },
  tag: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.bgAlt,
    borderWidth: 1,
    borderColor: colors.border
  },
  tagOk: { backgroundColor: "#E0F4E8", borderColor: colors.success },
  tagBad: { backgroundColor: "#FDECEA", borderColor: colors.danger },
  tagText: { fontSize: 12, fontWeight: "600", color: colors.text },
  tagTextActive: { color: colors.text },

  input: {
    backgroundColor: colors.bgAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing(3),
    minHeight: 64,
    fontSize: 14,
    color: colors.text,
    textAlignVertical: "top"
  },

  actions: {
    flexDirection: "row",
    gap: 12,
    marginTop: spacing(4),
    alignItems: "center"
  },
  skipBtn: { flex: 1, paddingVertical: 12, alignItems: "center" },
  skipText: { color: colors.soft, fontSize: 14, fontWeight: "700" },
  submitBtn: {
    flex: 1.5,
    backgroundColor: colors.text,
    paddingVertical: 14,
    alignItems: "center",
    borderRadius: radii.md
  },
  submitText: { color: colors.primaryText, fontSize: 14, fontWeight: "800" }
});
