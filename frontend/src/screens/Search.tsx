import React, { useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Alert
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";
import { CityPicker, City } from "@/components/CityPicker";
import { DateField } from "@/components/DateField";
import { colors, radii, spacing, shadow } from "@/theme";
import { toApiDate } from "@/utils/dateUtils";
import type { RootStackParamList } from "@/navigation/RootNavigator";

type Nav = NativeStackNavigationProp<RootStackParamList, "Tabs">;

export function SearchScreen() {
  const nav = useNavigation<Nav>();
  const [origin, setOrigin] = useState<City | null>(null);
  const [destination, setDestination] = useState<City | null>(null);
  const [date, setDate] = useState<Date | null>(null);
  const [seats, setSeats] = useState(1);

  function swapEndpoints() {
    setOrigin(destination);
    setDestination(origin);
  }

  function clearDate() {
    setDate(null);
  }

  function onSearch() {
    if (!origin || !destination) {
      Alert.alert("Select endpoints", "Pick a starting and a destination city.");
      return;
    }
    if (origin.id === destination.id) {
      Alert.alert(
        "Same city",
        "Origin and destination can't be the same city."
      );
      return;
    }
    nav.navigate("SearchResults", {
      origin,
      destination,
      date: date ? toApiDate(date) : undefined,
      seats
    });
  }

  return (
    <SafeAreaView style={s.shell} edges={["top"]}>
      <ScrollView
        contentContainerStyle={{ padding: spacing(4), paddingBottom: spacing(10) }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.h1}>Where are you going?</Text>
        <Text style={s.sub}>Find a ride and travel for less.</Text>

        <View style={[s.card, shadow.card]}>
          <CityPicker
            label="From"
            value={origin}
            onChange={setOrigin}
            placeholder="Pickup city"
            iconName="radio-button-on"
            excludeId={destination?.id}
          />

          <View style={s.swapRow}>
            <View style={s.swapLine} />
            <TouchableOpacity onPress={swapEndpoints} style={s.swapBtn} activeOpacity={0.7}>
              <Ionicons name="swap-vertical" size={16} color={colors.text} />
            </TouchableOpacity>
          </View>

          <CityPicker
            label="To"
            value={destination}
            onChange={setDestination}
            placeholder="Drop-off city"
            iconName="location"
            excludeId={origin?.id}
          />

          <View style={{ marginTop: spacing(2) }}>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <View style={{ flex: 1 }}>
                <DateField
                  label="Date (optional)"
                  value={date}
                  onChange={setDate}
                />
              </View>
              {date ? (
                <TouchableOpacity onPress={clearDate} style={s.clearBtn} hitSlop={6}>
                  <Ionicons name="close" size={14} color={colors.text} />
                  <Text style={s.clearText}>Any date</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>

          <View style={{ marginTop: spacing(3) }}>
            <Text style={s.label}>Seats</Text>
            <View style={s.seatRow}>
              <TouchableOpacity
                onPress={() => setSeats(Math.max(1, seats - 1))}
                style={s.seatBtn}
                hitSlop={8}
              >
                <Ionicons name="remove" size={18} color={colors.text} />
              </TouchableOpacity>
              <View style={{ alignItems: "center" }}>
                <Text style={s.seatVal}>{seats}</Text>
                <Text style={s.seatSub}>{seats === 1 ? "passenger" : "passengers"}</Text>
              </View>
              <TouchableOpacity
                onPress={() => setSeats(Math.min(8, seats + 1))}
                style={s.seatBtn}
                hitSlop={8}
              >
                <Ionicons name="add" size={18} color={colors.text} />
              </TouchableOpacity>
            </View>
          </View>

          <TouchableOpacity style={s.btn} onPress={onSearch} activeOpacity={0.85}>
            <Text style={s.btnText}>Search rides</Text>
            <Ionicons name="arrow-forward" size={18} color={colors.primaryText} />
          </TouchableOpacity>
        </View>

        <View style={s.tip}>
          <Ionicons name="information-circle-outline" size={16} color={colors.soft} />
          <Text style={s.tipText}>
            Tip — A→Z rides also show up for A→M searches. We match endpoints
            and intermediate stops.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg },
  h1: { fontSize: 26, fontWeight: "800", color: colors.text, marginBottom: 4, letterSpacing: -0.4 },
  sub: { fontSize: 14, color: colors.soft, marginBottom: spacing(4) },
  card: {
    backgroundColor: colors.card,
    padding: spacing(4),
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 4
  },
  label: {
    fontSize: 12,
    color: colors.soft,
    marginBottom: 6,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.4
  },
  seatRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    backgroundColor: colors.bgAlt,
    paddingHorizontal: 12,
    paddingVertical: 10,
    height: 64
  },
  seatBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border
  },
  seatVal: { fontSize: 20, fontWeight: "800", color: colors.text, letterSpacing: -0.5 },
  seatSub: { fontSize: 11, color: colors.soft },

  swapRow: { flexDirection: "row", alignItems: "center", marginVertical: -2, height: 16 },
  swapLine: { flex: 1, height: 1, backgroundColor: colors.border },
  swapBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
    marginHorizontal: 8
  },

  clearBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginLeft: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.bgAlt,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: 18
  },
  clearText: { color: colors.text, fontSize: 12, fontWeight: "600" },

  btn: {
    marginTop: spacing(4),
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: 16,
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    gap: 8
  },
  btnText: { color: colors.primaryText, fontWeight: "700", fontSize: 16, letterSpacing: -0.2 },

  tip: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    marginTop: spacing(4),
    paddingHorizontal: spacing(2)
  },
  tipText: { color: colors.soft, fontSize: 12, flex: 1, lineHeight: 18 }
});
