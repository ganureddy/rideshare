// Modern native date picker.
//
// Wraps @react-native-community/datetimepicker with our visual style and a
// platform-aware dismissal strategy:
//   • Android — picker auto-dismisses on selection (system behaviour).
//   • iOS     — picker stays open inline; user taps "Done" to close.
//
// The component is *date-only*; pair it with TimeField when you need both.

import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  Modal,
  Pressable
} from "react-native";
import DateTimePicker, { DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { Ionicons } from "@expo/vector-icons";
import { colors, radii } from "@/theme";

type Props = {
  label: string;
  value: Date | null;
  onChange: (d: Date) => void;
  /** Minimum selectable date — defaults to today (00:00). */
  minimumDate?: Date;
  /** Maximum selectable date — optional. */
  maximumDate?: Date;
  /** Override placeholder text shown when no value is set. */
  placeholder?: string;
};

function fmt(d: Date): string {
  return d.toLocaleDateString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric"
  });
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export function DateField({
  label,
  value,
  onChange,
  minimumDate,
  maximumDate,
  placeholder
}: Props) {
  const [show, setShow] = useState(false);

  function commit(selected: Date) {
    // Preserve the time-of-day from the existing value (so the parent can
    // pair this with TimeField without losing data); fall back to noon.
    const next = value ? new Date(value) : new Date();
    next.setFullYear(selected.getFullYear(), selected.getMonth(), selected.getDate());
    if (!value) next.setHours(9, 0, 0, 0);
    onChange(next);
  }

  function onPickerChange(_e: DateTimePickerEvent, selected?: Date) {
    if (Platform.OS === "android") {
      setShow(false);
      if (selected) commit(selected);
    } else {
      // iOS: spinner/inline picker — keep showing until user taps Done.
      if (selected) commit(selected);
    }
  }

  const open = () => setShow(true);

  return (
    <View>
      <Text style={s.label}>{label}</Text>
      <TouchableOpacity style={s.field} onPress={open} activeOpacity={0.7}>
        <Ionicons name="calendar-outline" size={18} color={colors.soft} style={{ marginLeft: 12 }} />
        <Text style={[s.fieldText, !value && s.placeholder]} numberOfLines={1}>
          {value ? fmt(value) : (placeholder ?? "Select date")}
        </Text>
        <Ionicons name="chevron-down" size={18} color={colors.mute} style={{ marginRight: 12 }} />
      </TouchableOpacity>

      {/* Android — open as bare native dialog */}
      {Platform.OS === "android" && show ? (
        <DateTimePicker
          value={value || new Date()}
          mode="date"
          display="default"
          minimumDate={minimumDate || startOfToday()}
          maximumDate={maximumDate}
          onChange={onPickerChange}
        />
      ) : null}

      {/* iOS — wrap in a centred modal so we can show a Done button */}
      {Platform.OS === "ios" ? (
        <Modal visible={show} transparent animationType="fade" onRequestClose={() => setShow(false)}>
          <Pressable style={s.iosBackdrop} onPress={() => setShow(false)}>
            <Pressable style={s.iosCard} onPress={() => {}}>
              <Text style={s.iosTitle}>{label}</Text>
              <DateTimePicker
                value={value || new Date()}
                mode="date"
                display="inline"
                minimumDate={minimumDate || startOfToday()}
                maximumDate={maximumDate}
                onChange={onPickerChange}
              />
              <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 16, padding: 12 }}>
                <TouchableOpacity onPress={() => setShow(false)}>
                  <Text style={s.iosBtn}>Done</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  label: {
    fontSize: 12,
    color: colors.soft,
    marginBottom: 6,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.4
  },
  field: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    backgroundColor: colors.bgAlt,
    height: 50
  },
  fieldText: {
    flex: 1,
    paddingHorizontal: 12,
    fontSize: 15,
    color: colors.text,
    fontWeight: "500"
  },
  placeholder: { color: colors.mute, fontWeight: "400" },

  iosBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", padding: 20 },
  iosCard: { backgroundColor: "#fff", borderRadius: 14, paddingTop: 14, overflow: "hidden" },
  iosTitle: { fontSize: 14, fontWeight: "700", color: colors.text, paddingHorizontal: 16, paddingBottom: 4 },
  iosBtn: { color: colors.text, fontWeight: "700", fontSize: 16 }
});
