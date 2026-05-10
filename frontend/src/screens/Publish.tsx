import React, { useEffect, useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Alert, ActivityIndicator, Switch
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Location from "expo-location";
import { PlacesAutocomplete, Place } from "@/components/PlacesAutocomplete";
import { call } from "@/api/client";
import { colors, radii, spacing } from "@/theme";

type PriceSuggest = {
  distance_km: number;
  duration_minutes: number;
  min_price: number;
  max_price: number;
  suggested_price: number;
};

export function PublishScreen() {
  const [origin, setOrigin] = useState<Place | null>(null);
  const [destination, setDestination] = useState<Place | null>(null);
  const [departure, setDeparture] = useState(""); // YYYY-MM-DD HH:mm:ss
  const [seats, setSeats] = useState("3");
  const [price, setPrice] = useState("");
  const [instant, setInstant] = useState(true);
  const [womenOnly, setWomenOnly] = useState(false);
  const [description, setDescription] = useState("");
  const [suggest, setSuggest] = useState<PriceSuggest | null>(null);
  const [bias, setBias] = useState<{ lat: number; lng: number } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== "granted") return;
      const loc = await Location.getLastKnownPositionAsync().catch(() => null);
      if (loc) setBias({ lat: loc.coords.latitude, lng: loc.coords.longitude });
    })();
  }, []);

  useEffect(() => {
    if (!origin?.lat || !destination?.lat) return;
    call<PriceSuggest>("rideshare.api.rides.suggest_price", {
      origin_lat: origin.lat,
      origin_lng: origin.lng,
      destination_lat: destination.lat,
      destination_lng: destination.lng
    })
      .then((s) => {
        setSuggest(s);
        if (!price) setPrice(String(s.suggested_price));
      })
      .catch(() => {/* ignore */});
  }, [origin, destination]);

  async function publish() {
    if (!origin || !destination || !departure || !price) {
      Alert.alert("Fill in route, departure time, and price.");
      return;
    }
    setBusy(true);
    try {
      // We need a vehicle ID and driver profile — for MVP we use the user's
      // first vehicle if it exists.  Wizards for full onboarding live in
      // the web app; the API uses the same backing endpoints.
      const vehicles = await call<any[]>("frappe.client.get_list", {
        doctype: "Vehicle",
        filters: JSON.stringify([["owner_user", "=", "@me"]]),
        fields: JSON.stringify(["name"]),
        limit_page_length: 1
      }).catch(() => []);
      const vehicleId = vehicles?.[0]?.name;
      if (!vehicleId) {
        Alert.alert("No vehicle on file", "Add a vehicle from your Profile first.");
        return;
      }
      const payload = {
        vehicle: vehicleId,
        origin_city: origin.city || origin.primary_text,
        origin_address: origin.address || origin.description,
        origin_lat: origin.lat,
        origin_lng: origin.lng,
        destination_city: destination.city || destination.primary_text,
        destination_address: destination.address || destination.description,
        destination_lat: destination.lat,
        destination_lng: destination.lng,
        departure_datetime: departure,
        seats_total: parseInt(seats, 10) || 3,
        price_per_seat: parseFloat(price),
        instant_booking: instant ? 1 : 0,
        women_only: womenOnly ? 1 : 0,
        description
      };
      await call("rideshare.api.rides.publish_ride", { payload: JSON.stringify(payload) });
      Alert.alert("Ride published", "Passengers can now find and book it.");
      setOrigin(null); setDestination(null); setDeparture(""); setPrice(""); setDescription("");
    } catch (e: any) {
      Alert.alert("Couldn't publish", e?.message ?? "Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={s.shell}>
      <ScrollView contentContainerStyle={{ padding: spacing(4) }} keyboardShouldPersistTaps="handled">
        <Text style={s.h1}>Publish a ride</Text>
        <View style={s.card}>
          <PlacesAutocomplete label="From" value={origin} onChange={setOrigin} bias={bias} />
          <PlacesAutocomplete label="To" value={destination} onChange={setDestination} bias={bias} />

          <Text style={s.label}>Departure (YYYY-MM-DD HH:mm:ss)</Text>
          <TextInput style={s.input} value={departure} onChangeText={setDeparture} placeholder="2026-05-15 09:00:00" placeholderTextColor={colors.soft} />

          <View style={{ flexDirection: "row", gap: spacing(3) }}>
            <View style={{ flex: 1 }}>
              <Text style={s.label}>Seats</Text>
              <TextInput style={s.input} value={seats} onChangeText={setSeats} keyboardType="number-pad" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.label}>Price / seat (₹)</Text>
              <TextInput style={s.input} value={price} onChangeText={setPrice} keyboardType="number-pad" />
            </View>
          </View>

          {suggest ? (
            <Text style={s.hint}>
              Suggested ₹{suggest.suggested_price} · {suggest.distance_km} km · ~{suggest.duration_minutes} min ·
              fair range ₹{suggest.min_price}–₹{suggest.max_price}
            </Text>
          ) : null}

          <Row label="Instant booking" value={instant} onChange={setInstant} />
          <Row label="Women only" value={womenOnly} onChange={setWomenOnly} />

          <Text style={s.label}>Notes for passengers</Text>
          <TextInput
            style={[s.input, { height: 80 }]}
            value={description}
            onChangeText={setDescription}
            placeholder="Pickup spot, luggage limits, music preferences…"
            placeholderTextColor={colors.soft}
            multiline
          />

          <TouchableOpacity style={[s.btn, busy && { opacity: 0.6 }]} onPress={publish} disabled={busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>Publish ride</Text>}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value, onChange }: { label: string; value: boolean; onChange: (b: boolean) => void }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: spacing(3) }}>
      <Text style={{ color: colors.text, fontSize: 15 }}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.blue, false: "#ccc" }} />
    </View>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg },
  h1: { fontSize: 22, fontWeight: "700", color: colors.text, marginBottom: spacing(3) },
  card: { backgroundColor: colors.card, padding: spacing(4), borderRadius: radii.lg },
  label: { fontSize: 12, color: colors.soft, marginTop: spacing(3), marginBottom: 6 },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: colors.text, backgroundColor: "#fff"
  },
  btn: { marginTop: spacing(5), backgroundColor: colors.blue, borderRadius: radii.md, paddingVertical: 14, alignItems: "center" },
  btnText: { color: "#fff", fontWeight: "600", fontSize: 16 },
  hint: { color: colors.soft, fontSize: 12, marginTop: spacing(2) }
});
