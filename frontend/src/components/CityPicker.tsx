// Searchable picker for Frappe `City` records.
//
// Behaves like a Frappe Link field: every keystroke triggers a debounced
// server lookup against `rideshare.api.rides.list_cities_public` with the
// query string, so partial words ("ban", "del", "mum") return matching
// suggestions ranked by `city_name LIKE %q%`.  The backend already handles
// is_active = 1 and ordering.

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  Modal,
  StyleSheet,
  Pressable,
  ActivityIndicator
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { call } from "@/api/client";
import { colors, radii, spacing } from "@/theme";

export type City = {
  id: string;        // Frappe `City.name` (== city_name; autoname=field:city_name)
  label: string;     // city_name
  state?: string;
  country?: string;
  lat?: number;
  lng?: number;
  slug?: string;
};

// Cache the empty-query top list so opening the picker is instant after the
// first time. Per-query results aren't cached to keep them fresh across
// admin changes.
let _topCache: City[] | null = null;
let _topInflight: Promise<City[]> | null = null;

async function fetchTop(): Promise<City[]> {
  if (_topCache) return _topCache;
  if (_topInflight) return _topInflight;
  _topInflight = call<City[]>("rideshare.api.rides.list_cities_public", { limit: 50 })
    .then((res) => {
      _topCache = Array.isArray(res) ? res : [];
      return _topCache;
    })
    .finally(() => {
      _topInflight = null;
    });
  return _topInflight;
}

async function fetchByQuery(q: string): Promise<City[]> {
  const res = await call<City[]>("rideshare.api.rides.list_cities_public", {
    query: q,
    limit: 30
  });
  return Array.isArray(res) ? res : [];
}

type Props = {
  label: string;
  value: City | null;
  onChange: (c: City | null) => void;
  placeholder?: string;
  iconName?: keyof typeof Ionicons.glyphMap;
  /** When set, this city is hidden from the dropdown (avoids picking the
   *  same city as origin and destination). */
  excludeId?: string;
};

export function CityPicker({
  label,
  value,
  onChange,
  placeholder,
  iconName = "location",
  excludeId
}: Props) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<City[]>(_topCache || []);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guard against stale responses overwriting a newer query's results.
  const reqIdRef = useRef(0);

  // Initial / empty-query load when the modal opens.
  useEffect(() => {
    if (!open) return;
    if (query.trim()) return; // empty-state load only
    setLoading(true);
    setErr(null);
    fetchTop()
      .then((c) => setItems(c))
      .catch((e) => setErr(e?.message ?? "Couldn't load cities."))
      .finally(() => setLoading(false));
  }, [open]);

  // Debounced server-side search: fires on every keystroke once the user has
  // typed at least one character.
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) {
      // Restore the cached top list when the user clears the input.
      if (_topCache) setItems(_topCache);
      setErr(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setErr(null);
    const myReq = ++reqIdRef.current;
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetchByQuery(q);
        if (myReq === reqIdRef.current) setItems(res);
      } catch (e: any) {
        if (myReq === reqIdRef.current) {
          setErr(e?.message ?? "Couldn't search cities.");
          setItems([]);
        }
      } finally {
        if (myReq === reqIdRef.current) setLoading(false);
      }
    }, 220);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open]);

  const filtered = useMemo(() => {
    if (!excludeId) return items;
    return items.filter((c) => c.id !== excludeId);
  }, [items, excludeId]);

  function close() {
    setOpen(false);
    setQuery("");
  }

  function pick(c: City) {
    onChange(c);
    close();
  }

  return (
    <View style={{ marginBottom: spacing(3) }}>
      <Text style={s.label}>{label}</Text>
      <TouchableOpacity
        style={s.field}
        onPress={() => setOpen(true)}
        activeOpacity={0.7}
      >
        <Ionicons name={iconName} size={18} color={colors.soft} style={{ marginLeft: 12 }} />
        <Text
          style={[s.fieldText, !value && s.fieldPlaceholder]}
          numberOfLines={1}
        >
          {value
            ? `${value.label}${value.state ? `, ${value.state}` : ""}`
            : (placeholder ?? "Select a city")}
        </Text>
        {value ? (
          <Pressable
            onPress={() => onChange(null)}
            hitSlop={10}
            style={{ paddingHorizontal: 12 }}
          >
            <Ionicons name="close-circle" size={18} color={colors.mute} />
          </Pressable>
        ) : (
          <Ionicons name="chevron-down" size={18} color={colors.mute} style={{ marginRight: 12 }} />
        )}
      </TouchableOpacity>

      <Modal
        visible={open}
        animationType="slide"
        onRequestClose={close}
        presentationStyle="pageSheet"
      >
        <SafeAreaView style={s.modal} edges={["top"]}>
          <View style={s.modalHeader}>
            <TouchableOpacity onPress={close} hitSlop={12}>
              <Ionicons name="close" size={26} color={colors.text} />
            </TouchableOpacity>
            <Text style={s.modalTitle}>{label}</Text>
            <View style={{ width: 26 }} />
          </View>

          <View style={s.searchWrap}>
            <Ionicons name="search" size={18} color={colors.soft} />
            <TextInput
              style={s.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="Type to search city or state…"
              placeholderTextColor={colors.mute}
              autoCapitalize="words"
              autoCorrect={false}
              autoFocus
            />
            {loading ? (
              <ActivityIndicator color={colors.text} size="small" />
            ) : query ? (
              <Pressable onPress={() => setQuery("")} hitSlop={10}>
                <Ionicons name="close-circle" size={18} color={colors.mute} />
              </Pressable>
            ) : null}
          </View>

          {err ? (
            <View style={s.center}>
              <Ionicons name="warning-outline" size={36} color={colors.warn} />
              <Text style={s.dim}>{err}</Text>
              <TouchableOpacity
                style={s.retryBtn}
                onPress={() => {
                  setErr(null);
                  setQuery((q) => q); // re-trigger effect
                }}
              >
                <Text style={s.retryText}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <FlatList
              data={filtered}
              keyExtractor={(c) => c.id}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={
                loading ? null : (
                  <View style={s.center}>
                    <Ionicons name="alert-circle-outline" size={36} color={colors.mute} />
                    <Text style={s.dim}>
                      {query.trim()
                        ? `No cities match "${query.trim()}".`
                        : "No cities available."}
                    </Text>
                    <Text style={s.dimSmall}>
                      Ask the admin to add it under City in Frappe Desk.
                    </Text>
                  </View>
                )
              }
              renderItem={({ item }) => {
                const selected = value?.id === item.id;
                return (
                  <TouchableOpacity style={s.row} onPress={() => pick(item)} activeOpacity={0.7}>
                    <View style={[s.rowIcon, selected && { backgroundColor: colors.text }]}>
                      <Ionicons
                        name="location"
                        size={16}
                        color={selected ? colors.primaryText : colors.text}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.rowTitle}>{item.label}</Text>
                      {item.state ? (
                        <Text style={s.rowSub}>
                          {item.state}
                          {item.country && item.country !== "India" ? ` · ${item.country}` : ""}
                        </Text>
                      ) : null}
                    </View>
                    {selected ? (
                      <Ionicons name="checkmark" size={20} color={colors.text} />
                    ) : null}
                  </TouchableOpacity>
                );
              }}
            />
          )}
        </SafeAreaView>
      </Modal>
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
  fieldPlaceholder: { color: colors.mute, fontWeight: "400" },

  modal: { flex: 1, backgroundColor: colors.bg },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing(4),
    paddingVertical: spacing(3),
    borderBottomWidth: 1,
    borderBottomColor: colors.border
  },
  modalTitle: { fontSize: 16, fontWeight: "700", color: colors.text },

  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: spacing(4),
    marginVertical: spacing(3),
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.bgAlt,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border
  },
  searchInput: { flex: 1, fontSize: 16, color: colors.text, padding: 0 },

  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing(4),
    paddingVertical: 14,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border
  },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.bgAlt,
    alignItems: "center",
    justifyContent: "center"
  },
  rowTitle: { fontSize: 15, fontWeight: "600", color: colors.text },
  rowSub: { fontSize: 12, color: colors.soft, marginTop: 2 },

  center: { padding: spacing(8), alignItems: "center", gap: 8 },
  dim: { color: colors.soft, marginTop: 4, textAlign: "center" },
  dimSmall: { color: colors.mute, fontSize: 12, textAlign: "center" },

  retryBtn: {
    marginTop: 8,
    backgroundColor: colors.text,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999
  },
  retryText: { color: colors.primaryText, fontWeight: "700" }
});
