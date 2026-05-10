// Backend-proxied Places autocomplete. We never put the Google API key in
// the bundle — instead, the device sends the partial query to the Frappe
// server which proxies to Google with the server-side key.
//
// Behaviour mirrors Google's Places SDK: as the user types, we throttle
// requests (200ms debounce), maintain a session_token across keystrokes,
// and use lat/lng biasing when the device location is available.

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet
} from "react-native";
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
};

export function PlacesAutocomplete({ label, placeholder, value, onChange, bias }: Props) {
  const [text, setText] = useState(value?.description ?? "");
  const [results, setResults] = useState<Prediction[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const sessionToken = useMemo(
    () => `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    // New session per mount; reset after a place is picked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
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
    setLoading(true);
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
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={{ marginBottom: spacing(3) }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        style={s.input}
        value={text}
        onChangeText={onTextChange}
        placeholder={placeholder ?? "City, address or landmark"}
        placeholderTextColor={colors.soft}
        autoCorrect={false}
      />
      {loading ? <ActivityIndicator style={{ marginTop: 6 }} color={colors.blue} /> : null}
      {open && results.length > 0 ? (
        <View style={s.dropdown}>
          <FlatList
            keyboardShouldPersistTaps="handled"
            data={results}
            keyExtractor={(it) => it.place_id}
            renderItem={({ item }) => (
              <TouchableOpacity onPress={() => pick(item)} style={s.row}>
                <Text style={s.primary}>{item.primary_text ?? item.description}</Text>
                {item.secondary_text ? (
                  <Text style={s.secondary}>{item.secondary_text}</Text>
                ) : null}
              </TouchableOpacity>
            )}
          />
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  label: { fontSize: 12, color: colors.soft, marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.card
  },
  dropdown: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.card,
    maxHeight: 240
  },
  row: { paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  primary: { fontSize: 15, color: colors.text },
  secondary: { fontSize: 12, color: colors.soft, marginTop: 2 }
});
