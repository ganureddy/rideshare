// Modern native time picker (12 h on iOS, system locale on Android).
//
// See `DateField` for the date counterpart.  This component preserves the
// date portion of the existing `value` and only mutates hours/minutes, so
// you can compose them safely.

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
  placeholder?: string;
};

function fmt(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function TimeField({ label, value, onChange, placeholder }: Props) {
  const [show, setShow] = useState(false);

  function commit(selected: Date) {
    const next = value ? new Date(value) : new Date();
    next.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
    onChange(next);
  }

  function onPickerChange(_e: DateTimePickerEvent, selected?: Date) {
    if (Platform.OS === "android") {
      setShow(false);
      if (selected) commit(selected);
    } else {
      if (selected) commit(selected);
    }
  }

  return (
    <View>
      <Text style={s.label}>{label}</Text>
      <TouchableOpacity style={s.field} onPress={() => setShow(true)} activeOpacity={0.7}>
        <Ionicons name="time-outline" size={18} color={colors.soft} style={{ marginLeft: 12 }} />
        <Text style={[s.fieldText, !value && s.placeholder]} numberOfLines={1}>
          {value ? fmt(value) : (placeholder ?? "Select time")}
        </Text>
        <Ionicons name="chevron-down" size={18} color={colors.mute} style={{ marginRight: 12 }} />
      </TouchableOpacity>

      {Platform.OS === "android" && show ? (
        <DateTimePicker
          value={value || new Date()}
          mode="time"
          is24Hour={false}
          display="default"
          onChange={onPickerChange}
        />
      ) : null}

      {Platform.OS === "ios" ? (
        <Modal visible={show} transparent animationType="fade" onRequestClose={() => setShow(false)}>
          <Pressable style={s.iosBackdrop} onPress={() => setShow(false)}>
            <Pressable style={s.iosCard} onPress={() => {}}>
              <Text style={s.iosTitle}>{label}</Text>
              <DateTimePicker
                value={value || new Date()}
                mode="time"
                is24Hour={false}
                display="spinner"
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
