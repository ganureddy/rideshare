// Backend-proxied Places autocomplete. We never put the Google API key in
// the bundle — the device sends the partial query to the Frappe server which
// proxies to Google with the server-side key.
//
// Behaviour mirrors Google's Places SDK: as the user types, we throttle
// requests (220ms debounce), maintain a session_token across keystrokes,
// and use lat/lng biasing when the device location is available.

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Pressable,
  Alert
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import * as Location from "expo-location";
import { call } from "@/api/client";
import { colors, radii, spacing } from "@/theme";

export type Place = {
  place_id: string;
  description: string;
  primary_text?: string;
  secondary_text?: string;
  lat?: number;
  lng?: number;
  city?: string;
  address?: string;
};

type Prediction = {
  place_id: string;
  description: string;
  primary_text?: string;
  secondary_text?: string;
};

type Props = {
  label: string;
  placeholder?: string;
  value?: Place | null;
  onChange: (place: Place | null) => void;
  bias?: { lat: number; lng: number } | null;
  /** Show the "Use current location" pill above the dropdown. Defaults true. */
  enableCurrentLocation?: boolean;
  /** Visual hint icon at the start of the input. */
  iconName?: keyof typeof Ionicons.glyphMap;
};

export function PlacesAutocomplete({
  label,
  placeholder,
  value,
  onChange,
  bias,
  enableCurrentLocation = true,
  iconName = "location-outline"
}: Props) {
  const [text, setText] = useState(value?.description ?? "");
  const [results, setResults] = useState<Prediction[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const sessionToken = useMemo(
    () => `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    []
  );
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setText(value?.description ?? "");
  }, [value?.description]);

  function onTextChange(next: string) {
    setText(next);
    if (value && next !== value.description) onChange(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (next.trim().length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await call<{ predictions: Prediction[] }>(
          "rideshare.api.places.autocomplete",
          {
            query: next,
            session_token: sessionToken,
            country: "in",
            lat: bias?.lat,
            lng: bias?.lng
          }
        );
        setResults(res.predictions || []);
        setOpen(true);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 220);
  }

  async function pick(p: Prediction) {
    setOpen(false);
    setResolving(true);
    try {
      const det = await call<Place>("rideshare.api.places.place_details", {
        place_id: p.place_id,
        session_token: sessionToken
      });
      const place: Place = {
        ...det,
        description: p.description,
        primary_text: p.primary_text,
        secondary_text: p.secondary_text
      };
      setText(p.description);
      onChange(place);
    } catch (e: any) {
      Alert.alert("Couldn't load place", e?.message ?? "Try again.");
    } finally {
      setResolving(false);
    }
  }

  async function useCurrentLocation() {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Permission needed", "Enable location to use this option.");
        return;
      }
      setResolving(true);
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High
      });
      const lat = loc.coords.latitude;
      const lng = loc.coords.longitude;
      const det = await call<Place & { city?: string; address?: string }>(
        "rideshare.api.places.reverse_geocode",
        { lat, lng }
      );
      const place: Place = {
        place_id: det.place_id || `geo_${lat}_${lng}`,
        description: det.address || `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
        primary_text: det.city || det.address,
        secondary_text: det.address,
        lat,
        lng,
        city: det.city,
        address: det.address
      };
      setText(place.description);
      onChange(place);
      setOpen(false);
    } catch (e: any) {
      Alert.alert("Couldn't get location", e?.message ?? "Try again.");
    } finally {
      setResolving(false);
    }
  }

  function clear() {
    setText("");
    onChange(null);
    setResults([]);
    setOpen(false);
  }

  return (
    <View style={{ marginBottom: spacing(3) }}>
      <Text style={s.label}>{label}</Text>
      <View style={s.inputWrap}>
        <Ionicons name={iconName} size={18} color={colors.soft} style={{ marginLeft: 12 }} />
        <TextInput
          style={s.input}
          value={text}
          onChangeText={onTextChange}
          placeholder={placeholder ?? "City, address or landmark"}
          placeholderTextColor={colors.mute}
          autoCorrect={false}
          autoCapitalize="words"
          onFocus={() => results.length > 0 && setOpen(true)}
        />
        {loading || resolving ? (
          <ActivityIndicator color={colors.text} style={{ marginRight: 12 }} />
        ) : text.length > 0 ? (
          <Pressable onPress={clear} hitSlop={10} style={{ paddingHorizontal: 12 }}>
            <Ionicons name="close-circle" size={18} color={colors.mute} />
          </Pressable>
        ) : null}
      </View>

      {open && (results.length > 0 || enableCurrentLocation) ? (
        <View style={s.dropdown}>
          {enableCurrentLocation ? (
            <TouchableOpacity onPress={useCurrentLocation} style={s.row}>
              <Ionicons name="locate" size={18} color={colors.text} />
              <View style={{ flex: 1 }}>
                <Text style={s.primary}>Use current location</Text>
                <Text style={s.secondary}>GPS-detected pickup</Text>
              </View>
            </TouchableOpacity>
          ) : null}
          <FlatList
            keyboardShouldPersistTaps="handled"
            data={results}
            keyExtractor={(it) => it.place_id}
            renderItem={({ item }) => (
              <TouchableOpacity onPress={() => pick(item)} style={s.row}>
                <Ionicons name="location" size={18} color={colors.soft} />
                <View style={{ flex: 1 }}>
                  <Text style={s.primary} numberOfLines={1}>
                    {item.primary_text ?? item.description}
                  </Text>
                  {item.secondary_text ? (
                    <Text style={s.secondary} numberOfLines={1}>{item.secondary_text}</Text>
                  ) : null}
                </View>
              </TouchableOpacity>
            )}
          />
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  label: { fontSize: 12, color: colors.soft, marginBottom: 6, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.4 },
  inputWrap: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    backgroundColor: colors.bgAlt
  },
  input: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 14,
    fontSize: 15,
    color: colors.text,
    fontWeight: "500"
  },
  dropdown: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.card,
    maxHeight: 280,
    overflow: "hidden"
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border
  },
  primary: { fontSize: 15, color: colors.text, fontWeight: "600" },
  secondary: { fontSize: 12, color: colors.soft, marginTop: 2 }
});
