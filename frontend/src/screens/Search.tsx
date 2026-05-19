// Search screen — single-screen layout.  Everything is visible without
// scrolling: From/To with swap, date + seats row, every filter inline,
// and the search CTA at the bottom of the viewport.
//
// Filters are always visible (no collapsible) so the user can adjust
// them with zero extra taps.  Sort selector is a compact pill row;
// instant-booking and women-only are inline checkmark toggles; max
// price is a tiny inline numeric field.

import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  Alert
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import Ionicons from "@expo/vector-icons/Ionicons";
import { CityPicker, City } from "@/components/CityPicker";
import { DateField } from "@/components/DateField";
import { colors, radii, spacing, shadow } from "@/theme";
import { toApiDate } from "@/utils/dateUtils";
import type { RideSort, RootStackParamList } from "@/navigation/RootNavigator";

type Nav = NativeStackNavigationProp<RootStackParamList, "Tabs">;

const SORT_OPTIONS: { id: RideSort; label: string; icon: any }[] = [
  { id: "departure", label: "Earliest", icon: "time-outline" },
  { id: "price_asc", label: "Cheapest", icon: "trending-down-outline" },
  { id: "price_desc", label: "Premium", icon: "trending-up-outline" },
  { id: "duration", label: "Fastest", icon: "flash-outline" }
];

export function SearchScreen() {
  const nav = useNavigation<Nav>();
  const [origin, setOrigin] = useState<City | null>(null);
  const [destination, setDestination] = useState<City | null>(null);
  const [date, setDate] = useState<Date | null>(null);
  const [seats, setSeats] = useState(1);
  const [sort, setSort] = useState<RideSort>("departure");
  const [instantOnly, setInstantOnly] = useState(false);
  const [womenOnly, setWomenOnly] = useState(false);
  const [maxPriceText, setMaxPriceText] = useState("");

  const canSearch = !!origin && !!destination;
  const activeFilters = useMemo(() => {
    let n = 0;
    if (sort !== "departure") n += 1;
    if (instantOnly) n += 1;
    if (womenOnly) n += 1;
    if (Number(maxPriceText) > 0) n += 1;
    return n;
  }, [sort, instantOnly, womenOnly, maxPriceText]);

  function swap() {
    setOrigin(destination);
    setDestination(origin);
  }

  function onSearch() {
    if (!origin || !destination) {
      Alert.alert("Pick endpoints", "Select a starting and a destination city.");
      return;
    }
    if (origin.id === destination.id) {
      Alert.alert("Same city", "Origin and destination can't be the same.");
      return;
    }
    const maxPrice = Number(maxPriceText);
    nav.navigate("SearchResults", {
      origin,
      destination,
      date: date ? toApiDate(date) : undefined,
      seats,
      sort,
      instantOnly: instantOnly ? 1 : 0,
      womenOnly: womenOnly ? 1 : 0,
      maxPrice: Number.isFinite(maxPrice) && maxPrice > 0 ? maxPrice : undefined
    });
  }

  return (
    <SafeAreaView style={s.shell} edges={["top"]}>
      <View style={s.outer}>
        {/* Title block */}
        <View style={s.titleRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.h1}>Where to?</Text>
            <Text style={s.sub}>Find a ride and travel for less.</Text>
          </View>
          {activeFilters > 0 ? (
            <View style={s.filterBadge}>
              <Ionicons name="options-outline" size={12} color={colors.primaryText} />
              <Text style={s.filterBadgeText}>{activeFilters}</Text>
            </View>
          ) : null}
        </View>

        {/* From / To card */}
        <View style={[s.card, shadow.card]}>
          <View style={s.routeRow}>
            <View style={s.routeRail}>
              <View style={[s.routeDot, { backgroundColor: colors.pickupPin }]} />
              <View style={s.routeLine} />
              <View
                style={[
                  s.routeDot,
                  s.routeDotSquare,
                  { backgroundColor: colors.dropoffPin }
                ]}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.fieldLabel}>From</Text>
              <CityPicker
                label=""
                value={origin}
                onChange={setOrigin}
                placeholder="Pickup city"
                iconName="radio-button-on"
                excludeId={destination?.id}
              />
              <View style={{ height: spacing(2) }} />
              <Text style={s.fieldLabel}>To</Text>
              <CityPicker
                label=""
                value={destination}
                onChange={setDestination}
                placeholder="Drop-off city"
                iconName="location"
                excludeId={origin?.id}
              />
            </View>
            <TouchableOpacity onPress={swap} style={s.swapBtn} activeOpacity={0.7} hitSlop={8}>
              <Ionicons name="swap-vertical" size={18} color={colors.text} />
            </TouchableOpacity>
          </View>

          {/* Date + seats row */}
          <View style={s.metaRow}>
            <View style={{ flex: 1.4 }}>
              <Text style={s.fieldLabel}>When</Text>
              <DateField
                label=""
                value={date}
                onChange={setDate}
                placeholder="Any date"
              />
            </View>
            <View style={{ width: 10 }} />
            <View style={{ flex: 1 }}>
              <Text style={s.fieldLabel}>Seats</Text>
              <View style={s.seatRow}>
                <TouchableOpacity
                  onPress={() => setSeats(Math.max(1, seats - 1))}
                  style={s.seatBtn}
                  hitSlop={6}
                >
                  <Ionicons name="remove" size={15} color={colors.text} />
                </TouchableOpacity>
                <Text style={s.seatVal}>{seats}</Text>
                <TouchableOpacity
                  onPress={() => setSeats(Math.min(8, seats + 1))}
                  style={s.seatBtn}
                  hitSlop={6}
                >
                  <Ionicons name="add" size={15} color={colors.text} />
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </View>

        {/* Filters — always visible, single card */}
        <View style={[s.filterCard, shadow.card]}>
          <Text style={s.filterTitle}>Sort & Filters</Text>

          <View style={s.sortRow}>
            {SORT_OPTIONS.map((opt) => {
              const active = sort === opt.id;
              return (
                <TouchableOpacity
                  key={opt.id}
                  style={[s.sortChip, active && s.sortChipActive]}
                  onPress={() => setSort(opt.id)}
                  activeOpacity={0.8}
                >
                  <Ionicons
                    name={opt.icon}
                    size={12}
                    color={active ? colors.primaryText : colors.text}
                  />
                  <Text style={[s.sortChipText, active && s.sortChipTextActive]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={s.checkRow}>
            <TouchableOpacity
              style={[s.checkChip, instantOnly && s.checkChipActive]}
              onPress={() => setInstantOnly((v) => !v)}
              activeOpacity={0.8}
            >
              <Ionicons
                name={instantOnly ? "checkbox" : "square-outline"}
                size={14}
                color={instantOnly ? colors.primaryText : colors.text}
              />
              <Text style={[s.checkChipText, instantOnly && s.checkChipTextActive]}>
                Instant booking
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[s.checkChip, womenOnly && s.checkChipActive]}
              onPress={() => setWomenOnly((v) => !v)}
              activeOpacity={0.8}
            >
              <Ionicons
                name={womenOnly ? "checkbox" : "square-outline"}
                size={14}
                color={womenOnly ? colors.primaryText : colors.text}
              />
              <Text style={[s.checkChipText, womenOnly && s.checkChipTextActive]}>
                Women-only
              </Text>
            </TouchableOpacity>

            <View style={s.priceField}>
              <Text style={s.priceCurrency}>₹</Text>
              <TextInput
                style={s.priceInput}
                value={maxPriceText}
                onChangeText={setMaxPriceText}
                placeholder="max"
                placeholderTextColor={colors.mute}
                keyboardType="number-pad"
                maxLength={6}
              />
            </View>
          </View>
        </View>

        <View style={{ flex: 1 }} />

        {/* Search CTA — bottom of viewport */}
        <TouchableOpacity
          style={[s.btn, !canSearch && s.btnDisabled]}
          onPress={onSearch}
          activeOpacity={0.85}
          disabled={!canSearch}
        >
          <Ionicons name="search" size={18} color={colors.primaryText} />
          <Text style={s.btnText}>Search rides</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg },
  outer: { flex: 1, padding: spacing(4) },

  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: spacing(3)
  },
  h1: { fontSize: 24, fontWeight: "800", color: colors.text, letterSpacing: -0.4 },
  sub: { fontSize: 13, color: colors.soft, marginTop: 2 },
  filterBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.text,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999
  },
  filterBadgeText: { color: colors.primaryText, fontSize: 11, fontWeight: "800" },

  card: {
    backgroundColor: colors.card,
    padding: spacing(3),
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border
  },

  // Route block
  routeRow: { flexDirection: "row", alignItems: "stretch" },
  routeRail: {
    width: 14,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 24,
    paddingBottom: 24,
    paddingRight: 4
  },
  routeDot: { width: 9, height: 9, borderRadius: 5 },
  routeDotSquare: { borderRadius: 2 },
  routeLine: {
    flex: 1,
    width: 2,
    backgroundColor: colors.borderStrong,
    marginVertical: 3
  },
  swapBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.bgAlt,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
    alignSelf: "center",
    marginLeft: 6
  },
  fieldLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: colors.soft,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 4,
    marginLeft: 2
  },

  // Meta
  metaRow: { flexDirection: "row", marginTop: spacing(2) },
  seatRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    backgroundColor: colors.bgAlt,
    paddingHorizontal: 8,
    height: 46
  },
  seatBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border
  },
  seatVal: { fontSize: 16, fontWeight: "800", color: colors.text, letterSpacing: -0.3 },

  // Filters
  filterCard: {
    marginTop: spacing(3),
    backgroundColor: colors.card,
    padding: spacing(3),
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing(2)
  },
  filterTitle: {
    fontSize: 11,
    fontWeight: "800",
    color: colors.soft,
    textTransform: "uppercase",
    letterSpacing: 0.5
  },
  sortRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  sortChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: colors.bgAlt,
    borderWidth: 1,
    borderColor: colors.border
  },
  sortChipActive: { backgroundColor: colors.text, borderColor: colors.text },
  sortChipText: { fontSize: 11, fontWeight: "700", color: colors.text },
  sortChipTextActive: { color: colors.primaryText },

  checkRow: { flexDirection: "row", gap: 6, flexWrap: "wrap", alignItems: "center" },
  checkChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: colors.bgAlt,
    borderWidth: 1,
    borderColor: colors.border
  },
  checkChipActive: { backgroundColor: colors.text, borderColor: colors.text },
  checkChipText: { fontSize: 11, fontWeight: "700", color: colors.text },
  checkChipTextActive: { color: colors.primaryText },

  priceField: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgAlt,
    borderRadius: 999,
    paddingHorizontal: 10,
    height: 32
  },
  priceCurrency: { fontSize: 12, fontWeight: "800", color: colors.text, marginRight: 2 },
  priceInput: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.text,
    paddingVertical: 0,
    minWidth: 48,
    maxWidth: 80
  },

  // CTA
  btn: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: 16,
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    gap: 8
  },
  btnDisabled: { backgroundColor: colors.mute },
  btnText: { color: colors.primaryText, fontWeight: "700", fontSize: 16, letterSpacing: -0.2 }
});
