import React, { useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, TextInput, StyleSheet, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { PlacesAutocomplete, Place } from "@/components/PlacesAutocomplete";
import { colors, radii, spacing } from "@/theme";
import type { RootStackParamList } from "@/navigation/RootNavigator";

type Nav = NativeStackNavigationProp<RootStackParamList, "Tabs">;

export function SearchScreen() {
  const nav = useNavigation<Nav>();
  const [origin, setOrigin] = useState<Place | null>(null);
  const [destination, setDestination] = useState<Place | null>(null);
  const [date, setDate] = useState(""); // YYYY-MM-DD
  const [seats, setSeats] = useState("1");

  function onSearch() {
    if (!origin || !destination) {
      Alert.alert("Pick a start and end location.");
      return;
    }
    nav.navigate("SearchResults", {
      origin,
      destination,
      date: date || undefined,
      seats: parseInt(seats, 10) || 1
    });
  }

  return (
    <SafeAreaView style={s.shell}>
      <ScrollView contentContainerStyle={{ padding: spacing(4) }} keyboardShouldPersistTaps="handled">
        <Text style={s.h1}>Where are you going?</Text>

        <View style={s.card}>
          <PlacesAutocomplete label="From" value={origin} onChange={setOrigin} placeholder="Pickup city or address" />
          <PlacesAutocomplete label="To" value={destination} onChange={setDestination} placeholder="Drop-off city or address" />

          <View style={{ flexDirection: "row", gap: spacing(3) }}>
            <View style={{ flex: 2 }}>
              <Text style={s.label}>Date</Text>
              <TextInput
                style={s.input}
                value={date}
                onChangeText={setDate}
                placeholder="2026-05-15"
                placeholderTextColor={colors.soft}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.label}>Seats</Text>
              <TextInput
                style={s.input}
                value={seats}
                onChangeText={setSeats}
                keyboardType="number-pad"
              />
            </View>
          </View>

          <TouchableOpacity style={s.btn} onPress={onSearch}>
            <Text style={s.btnText}>Search rides</Text>
          </TouchableOpacity>
        </View>

        <Text style={s.hint}>
          Tip: A→Z rides will also show for your A→M search — we match
          intermediate stops.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg },
  h1: { fontSize: 22, fontWeight: "700", color: colors.text, marginBottom: spacing(3) },
  card: { backgroundColor: colors.card, padding: spacing(4), borderRadius: radii.lg, gap: 6 },
  label: { fontSize: 12, color: colors.soft, marginBottom: 6, marginTop: 4 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.text,
    backgroundColor: "#fff"
  },
  btn: { marginTop: spacing(4), backgroundColor: colors.blue, borderRadius: radii.md, paddingVertical: 14, alignItems: "center" },
  btnText: { color: "#fff", fontWeight: "600", fontSize: 16 },
  hint: { color: colors.soft, fontSize: 12, marginTop: spacing(3), padding: spacing(2) }
});
