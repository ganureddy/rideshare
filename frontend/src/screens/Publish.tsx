import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Switch
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { CityPicker, City } from "@/components/CityPicker";
import { DateField } from "@/components/DateField";
import { TimeField } from "@/components/TimeField";
import { call } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { colors, radii, spacing, shadow } from "@/theme";
import {
  combineDateAndTime,
  defaultDeparture,
  toApiDate,
  toApiDateTime
} from "@/utils/dateUtils";
import type { RootStackParamList } from "@/navigation/RootNavigator";

type Nav = NativeStackNavigationProp<RootStackParamList, "Tabs">;

type PriceSuggest = {
  distance_km: number;
  duration_minutes: number;
  min_price: number;
  max_price: number;
  suggested_price: number;
};

type ExistingVehicle = {
  name: string;
  make?: string;
  model?: string;
  year?: number;
  color?: string;
  seats_available?: number;
};

type ExistingDriverProfile = {
  name?: string;
  full_name?: string;
  bio?: string;
  license_expiry?: string | null;
  preferences_music?: "Quiet" | "Some" | "Loud";
  preferences_chat?: "Quiet" | "Some" | "Chatty";
  preferences_smoking?: number;
  preferences_pets?: number;
} | null;

type DriverState = {
  vehicles: ExistingVehicle[];
  driver_profile: ExistingDriverProfile;
  can_publish: boolean;
};

const MUSIC_OPTIONS: Array<"Quiet" | "Some" | "Loud"> = ["Quiet", "Some", "Loud"];
const CHAT_OPTIONS: Array<"Quiet" | "Some" | "Chatty"> = ["Quiet", "Some", "Chatty"];
const SEAT_OPTIONS = Array.from({ length: 12 }, (_, i) => i + 1);
const CURRENT_YEAR = new Date().getFullYear();

export function PublishScreen() {
  const nav = useNavigation<Nav>();
  const { profile } = useAuth();

  // Route
  const [origin, setOrigin] = useState<City | null>(null);
  const [destination, setDestination] = useState<City | null>(null);

  // Departure split into Date + Time pickers; combined when sent.
  const [date, setDate] = useState<Date | null>(null);
  const [time, setTime] = useState<Date | null>(null);

  // Ride options
  const [seats, setSeats] = useState(3);
  const [price, setPrice] = useState("");
  const [instant, setInstant] = useState(true);
  const [womenOnly, setWomenOnly] = useState(false);
  const [description, setDescription] = useState("");
  const [suggest, setSuggest] = useState<PriceSuggest | null>(null);

  // Car details
  const [carMake, setCarMake] = useState("");
  const [carModel, setCarModel] = useState("");
  const [carYear, setCarYear] = useState("");
  const [carColor, setCarColor] = useState("");
  const [carSeats, setCarSeats] = useState<number>(4);
  const [carPlate, setCarPlate] = useState("");

  // Driver details
  const [driverName, setDriverName] = useState("");
  const [driverBio, setDriverBio] = useState("");
  const [licenseNumber, setLicenseNumber] = useState("");
  const [licenseExpiry, setLicenseExpiry] = useState<Date | null>(null);

  // Preferences (defaults per spec)
  const [prefMusic, setPrefMusic] = useState<"Quiet" | "Some" | "Loud">("Some");
  const [prefChat, setPrefChat] = useState<"Quiet" | "Some" | "Chatty">("Some");
  const [prefSmoking, setPrefSmoking] = useState(false);
  const [prefPets, setPrefPets] = useState(false);

  // Lifecycle
  const [busy, setBusy] = useState(false);
  const [driverState, setDriverState] = useState<DriverState | null>(null);
  const [enrolling, setEnrolling] = useState(false);

  useEffect(() => {
    loadDriverState();
    const initial = defaultDeparture();
    setDate(initial);
    setTime(initial);
  }, []);

  // Pre-fill the wizard from the user's existing vehicle / driver profile so
  // they don't have to retype the same details for every ride.
  useEffect(() => {
    if (!driverState) return;
    const v = driverState.vehicles?.[0];
    if (v) {
      if (!carMake) setCarMake(v.make || "");
      if (!carModel) setCarModel(v.model || "");
      if (!carYear && v.year) setCarYear(String(v.year));
      if (!carColor) setCarColor(v.color || "");
      if (v.seats_available) setCarSeats(Math.min(12, Math.max(1, v.seats_available)));
    }
    const dp = driverState.driver_profile;
    if (dp) {
      if (!driverName) setDriverName(dp.full_name || profile?.full_name || "");
      if (!driverBio) setDriverBio(dp.bio || "");
      if (dp.license_expiry && !licenseExpiry) {
        const d = new Date(dp.license_expiry);
        if (!isNaN(d.getTime())) setLicenseExpiry(d);
      }
      if (dp.preferences_music) setPrefMusic(dp.preferences_music);
      if (dp.preferences_chat) setPrefChat(dp.preferences_chat);
      setPrefSmoking(!!dp.preferences_smoking);
      setPrefPets(!!dp.preferences_pets);
    } else if (!driverName) {
      setDriverName(profile?.full_name || profile?.first_name || "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driverState]);

  async function loadDriverState() {
    try {
      const d = await call<DriverState>("rideshare.api.mobile.my_vehicles_summary");
      setDriverState(d);
    } catch {
      /* ignore — re-checked by the publish_ride backend */
    }
  }

  // Recompute the suggested price whenever both endpoints have lat/lng.
  useEffect(() => {
    if (!origin?.lat || !origin?.lng || !destination?.lat || !destination?.lng) return;
    call<PriceSuggest>("rideshare.api.rides.suggest_price", {
      origin_lat: origin.lat,
      origin_lng: origin.lng,
      destination_lat: destination.lat,
      destination_lng: destination.lng
    })
      .then((sg) => {
        setSuggest(sg);
        if (!price) setPrice(String(sg.suggested_price));
      })
      .catch(() => {/* network blip — leave the field empty */});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, destination]);

  // Don't let the ride seats exceed what the car holds.
  const maxRideSeats = useMemo(() => Math.min(12, Math.max(1, carSeats || 4)), [carSeats]);
  useEffect(() => {
    if (seats > maxRideSeats) setSeats(maxRideSeats);
  }, [maxRideSeats, seats]);

  async function becomeDriver() {
    setEnrolling(true);
    try {
      await call("rideshare.api.onboarding.quick_become_driver", {
        full_name: profile?.full_name || profile?.first_name
      });
      await loadDriverState();
    } catch (e: any) {
      Alert.alert("Couldn't enrol you", e?.message ?? "Try again.");
    } finally {
      setEnrolling(false);
    }
  }

  function validateBeforePublish(): string | null {
    if (!origin || !destination) return "Add both pickup and drop locations.";
    if (origin.id === destination.id) return "Origin and destination can't be the same city.";
    if (!date || !time) return "Select both a date and a time.";
    const departure = combineDateAndTime(date, time);
    if (departure.getTime() < Date.now() - 60 * 1000) return "Departure must be in the future.";
    if (!price || parseFloat(price) <= 0) return "Enter a price per seat.";
    if (!carMake.trim() || !carModel.trim()) return "Add your car's make and model.";
    if (!carYear.trim() || isNaN(parseInt(carYear)) || parseInt(carYear) < 1980 || parseInt(carYear) > CURRENT_YEAR + 1) {
      return "Enter a valid car year.";
    }
    if (!carPlate.trim()) return "Add your car's license plate.";
    if (!driverName.trim()) return "Add your full name.";
    if (!licenseNumber.trim()) return "Add your driving licence number.";
    if (!licenseExpiry) return "Pick your driving licence expiry date.";
    if (licenseExpiry.getTime() < Date.now()) return "Driving licence has expired — please renew before publishing.";
    return null;
  }

  async function publish() {
    const problem = validateBeforePublish();
    if (problem) {
      Alert.alert("Almost there", problem);
      return;
    }
    setBusy(true);
    try {
      const departure = combineDateAndTime(date!, time!);
      const payload = {
        origin_city: origin!.id,
        origin_address: origin!.label,
        origin_lat: origin!.lat,
        origin_lng: origin!.lng,
        destination_city: destination!.id,
        destination_address: destination!.label,
        destination_lat: destination!.lat,
        destination_lng: destination!.lng,
        departure_datetime: toApiDateTime(departure),
        seats_total: seats,
        price_per_seat: parseFloat(price),
        instant_booking: instant ? 1 : 0,
        women_only: womenOnly ? 1 : 0,
        description,
        vehicle_details: {
          make: carMake.trim(),
          model: carModel.trim(),
          year: parseInt(carYear),
          color: carColor.trim(),
          seats_available: carSeats,
          license_plate: carPlate.trim()
        },
        driver: {
          full_name: driverName.trim(),
          bio: driverBio.trim(),
          license_number: licenseNumber.trim(),
          license_expiry: licenseExpiry ? toApiDate(licenseExpiry) : null
        },
        preferences: {
          music: prefMusic,
          chat: prefChat,
          smoking: prefSmoking ? 1 : 0,
          pets: prefPets ? 1 : 0
        }
      };
      await call("rideshare.api.rides.publish_ride", { payload: JSON.stringify(payload) });
      Alert.alert("Ride published", "Passengers can now find and book it.");
      // Reset only the trip fields; keep car/driver/preferences populated for next time.
      setOrigin(null);
      setDestination(null);
      const next = defaultDeparture();
      setDate(next);
      setTime(next);
      setPrice("");
      setDescription("");
      nav.navigate("Tabs" as any);
    } catch (e: any) {
      Alert.alert("Couldn't publish", e?.message ?? "Try again.");
    } finally {
      setBusy(false);
    }
  }

  // Driver enrolment gate — non-drivers see the welcome screen first.
  if (driverState && !driverState.can_publish) {
    return (
      <SafeAreaView style={s.shell} edges={["top"]}>
        <ScrollView contentContainerStyle={{ padding: spacing(5) }}>
          <Text style={s.h1}>Become a driver</Text>
          <Text style={s.sub}>
            Earn by sharing your trip with passengers going the same way.
          </Text>

          <View style={[s.card, shadow.card, { marginTop: spacing(4) }]}>
            <Bullet icon="cash-outline" text="Split fuel & tolls with passengers" />
            <Bullet icon="people-outline" text="Choose who joins — instant or review-first" />
            <Bullet icon="shield-checkmark-outline" text="Live location is shared with riders only" />

            <TouchableOpacity
              style={[s.btn, enrolling && { opacity: 0.6 }]}
              onPress={becomeDriver}
              disabled={enrolling}
              activeOpacity={0.85}
            >
              {enrolling ? (
                <ActivityIndicator color={colors.primaryText} />
              ) : (
                <>
                  <Text style={s.btnText}>Enrol as driver</Text>
                  <Ionicons name="arrow-forward" size={18} color={colors.primaryText} />
                </>
              )}
            </TouchableOpacity>
            <Text style={s.note}>
              You'll fill in your car and licence details on the very next screen.
            </Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.shell} edges={["top"]}>
      <ScrollView
        contentContainerStyle={{ padding: spacing(4), paddingBottom: spacing(10) }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.h1}>Publish a ride</Text>
        <Text style={s.sub}>Tell us where you're going and what you drive.</Text>

        {/* TRIP */}
        <View style={[s.card, shadow.card]}>
          <SectionHeader icon="navigate-outline" label="Trip" />
          <CityPicker
            label="From"
            value={origin}
            onChange={setOrigin}
            placeholder="Pickup city"
            iconName="radio-button-on"
            excludeId={destination?.id}
          />
          <CityPicker
            label="To"
            value={destination}
            onChange={setDestination}
            placeholder="Drop-off city"
            iconName="location"
            excludeId={origin?.id}
          />

          <View style={{ flexDirection: "row", gap: spacing(3), marginTop: spacing(2) }}>
            <View style={{ flex: 1 }}>
              <DateField label="Date" value={date} onChange={setDate} />
            </View>
            <View style={{ flex: 1 }}>
              <TimeField label="Time" value={time} onChange={setTime} />
            </View>
          </View>

          <View style={{ flexDirection: "row", gap: spacing(3), marginTop: spacing(3) }}>
            <View style={{ flex: 1 }}>
              <Text style={s.label}>Seats offered</Text>
              <View style={s.seatRow}>
                <TouchableOpacity
                  onPress={() => setSeats(Math.max(1, seats - 1))}
                  style={s.seatBtn}
                  hitSlop={6}
                >
                  <Ionicons name="remove" size={16} color={colors.text} />
                </TouchableOpacity>
                <Text style={s.seatVal}>{seats}</Text>
                <TouchableOpacity
                  onPress={() => setSeats(Math.min(maxRideSeats, seats + 1))}
                  style={s.seatBtn}
                  hitSlop={6}
                >
                  <Ionicons name="add" size={16} color={colors.text} />
                </TouchableOpacity>
              </View>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.label}>Price / seat (₹)</Text>
              <TextInput
                style={s.boxInput}
                value={price}
                onChangeText={setPrice}
                keyboardType="number-pad"
                placeholder={suggest ? String(suggest.suggested_price) : "0"}
                placeholderTextColor={colors.mute}
              />
            </View>
          </View>

          {suggest ? (
            <View style={s.hint}>
              <Ionicons name="sparkles-outline" size={14} color={colors.soft} />
              <Text style={s.hintText}>
                Suggested ₹{suggest.suggested_price} · {suggest.distance_km} km · ~
                {suggest.duration_minutes} min · fair range ₹{suggest.min_price}–₹
                {suggest.max_price}
              </Text>
            </View>
          ) : null}

          <Row label="Instant booking" value={instant} onChange={setInstant} icon="flash-outline" />
          <Row label="Women only" value={womenOnly} onChange={setWomenOnly} icon="female-outline" />

          <Text style={s.label}>Notes for passengers</Text>
          <TextInput
            style={[s.boxInput, { height: 88, textAlignVertical: "top" }]}
            value={description}
            onChangeText={setDescription}
            placeholder="Pickup spot, luggage limits, etc."
            placeholderTextColor={colors.mute}
            multiline
          />
        </View>

        {/* CAR */}
        <View style={[s.card, shadow.card, { marginTop: spacing(3) }]}>
          <SectionHeader icon="car-sport-outline" label="Your car" />

          <View style={{ flexDirection: "row", gap: spacing(3) }}>
            <View style={{ flex: 1 }}>
              <Text style={s.label}>Make</Text>
              <TextInput
                style={s.boxInput}
                value={carMake}
                onChangeText={setCarMake}
                placeholder="Maruti"
                placeholderTextColor={colors.mute}
                autoCapitalize="words"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.label}>Model</Text>
              <TextInput
                style={s.boxInput}
                value={carModel}
                onChangeText={setCarModel}
                placeholder="Swift"
                placeholderTextColor={colors.mute}
                autoCapitalize="words"
              />
            </View>
          </View>

          <View style={{ flexDirection: "row", gap: spacing(3), marginTop: spacing(3) }}>
            <View style={{ flex: 1 }}>
              <Text style={s.label}>Year</Text>
              <TextInput
                style={s.boxInput}
                value={carYear}
                onChangeText={setCarYear}
                placeholder={String(CURRENT_YEAR)}
                placeholderTextColor={colors.mute}
                keyboardType="number-pad"
                maxLength={4}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.label}>Color</Text>
              <TextInput
                style={s.boxInput}
                value={carColor}
                onChangeText={setCarColor}
                placeholder="White"
                placeholderTextColor={colors.mute}
                autoCapitalize="words"
              />
            </View>
          </View>

          <Text style={[s.label, { marginTop: spacing(3) }]}>Passenger seats (1–12)</Text>
          <SeatGridPicker value={carSeats} onChange={setCarSeats} />

          <Text style={[s.label, { marginTop: spacing(3) }]}>License plate</Text>
          <TextInput
            style={s.boxInput}
            value={carPlate}
            onChangeText={(t) => setCarPlate(t.toUpperCase())}
            placeholder="DL01AB1234"
            placeholderTextColor={colors.mute}
            autoCapitalize="characters"
            autoCorrect={false}
          />
        </View>

        {/* DRIVER */}
        <View style={[s.card, shadow.card, { marginTop: spacing(3) }]}>
          <SectionHeader icon="person-circle-outline" label="Driver details" />

          <Text style={s.label}>Full name</Text>
          <TextInput
            style={s.boxInput}
            value={driverName}
            onChangeText={setDriverName}
            placeholder="As on your driving licence"
            placeholderTextColor={colors.mute}
            autoCapitalize="words"
          />

          <Text style={[s.label, { marginTop: spacing(3) }]}>Bio (optional)</Text>
          <TextInput
            style={[s.boxInput, { height: 72, textAlignVertical: "top" }]}
            value={driverBio}
            onChangeText={setDriverBio}
            placeholder="Tell passengers a bit about yourself."
            placeholderTextColor={colors.mute}
            multiline
          />

          <Text style={[s.label, { marginTop: spacing(3) }]}>Driving licence number</Text>
          <TextInput
            style={s.boxInput}
            value={licenseNumber}
            onChangeText={setLicenseNumber}
            placeholder="e.g. DL-1420110012345"
            placeholderTextColor={colors.mute}
            autoCapitalize="characters"
            autoCorrect={false}
          />

          <View style={{ marginTop: spacing(3) }}>
            <DateField
              label="Licence expiry"
              value={licenseExpiry}
              onChange={setLicenseExpiry}
              minimumDate={new Date()}
            />
          </View>
        </View>

        {/* PREFERENCES */}
        <View style={[s.card, shadow.card, { marginTop: spacing(3) }]}>
          <SectionHeader icon="options-outline" label="Preferences" />

          <Text style={s.label}>Music</Text>
          <SegmentPicker
            options={MUSIC_OPTIONS as readonly string[]}
            value={prefMusic}
            onChange={(v) => setPrefMusic(v as "Quiet" | "Some" | "Loud")}
          />

          <Text style={[s.label, { marginTop: spacing(3) }]}>Chat</Text>
          <SegmentPicker
            options={CHAT_OPTIONS as readonly string[]}
            value={prefChat}
            onChange={(v) => setPrefChat(v as "Quiet" | "Some" | "Chatty")}
          />

          <Row
            label="Smoking OK"
            value={prefSmoking}
            onChange={setPrefSmoking}
            icon="flame-outline"
          />
          <Row
            label="Pets OK"
            value={prefPets}
            onChange={setPrefPets}
            icon="paw-outline"
          />
        </View>

        <TouchableOpacity
          style={[s.btn, busy && { opacity: 0.6 }]}
          onPress={publish}
          disabled={busy}
          activeOpacity={0.85}
        >
          {busy ? (
            <ActivityIndicator color={colors.primaryText} />
          ) : (
            <>
              <Text style={s.btnText}>Publish ride</Text>
              <Ionicons name="checkmark" size={18} color={colors.primaryText} />
            </>
          )}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function SectionHeader({ icon, label }: { icon: any; label: string }) {
  return (
    <View style={s.sectionHead}>
      <Ionicons name={icon} size={16} color={colors.text} />
      <Text style={s.sectionHeadText}>{label}</Text>
    </View>
  );
}

function SegmentPicker({
  options,
  value,
  onChange
}: {
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <View style={s.segmentRow}>
      {options.map((opt) => {
        const active = opt === value;
        return (
          <TouchableOpacity
            key={opt}
            style={[s.segmentBtn, active && s.segmentBtnActive]}
            onPress={() => onChange(opt)}
            activeOpacity={0.8}
          >
            <Text style={[s.segmentText, active && s.segmentTextActive]}>{opt}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function SeatGridPicker({
  value,
  onChange
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <View style={s.seatGrid}>
      {SEAT_OPTIONS.map((n) => {
        const active = n === value;
        return (
          <TouchableOpacity
            key={n}
            style={[s.seatChip, active && s.seatChipActive]}
            onPress={() => onChange(n)}
            activeOpacity={0.8}
          >
            <Text style={[s.seatChipText, active && s.seatChipTextActive]}>{n}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function Bullet({ icon, text }: { icon: any; text: string }) {
  return (
    <View style={s.bullet}>
      <View style={s.bulletIcon}>
        <Ionicons name={icon} size={18} color={colors.text} />
      </View>
      <Text style={s.bulletText}>{text}</Text>
    </View>
  );
}

function Row({
  label,
  value,
  onChange,
  icon
}: {
  label: string;
  value: boolean;
  onChange: (b: boolean) => void;
  icon: any;
}) {
  return (
    <View style={s.row}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Ionicons name={icon} size={18} color={colors.text} />
        <Text style={{ color: colors.text, fontSize: 15, fontWeight: "500" }}>{label}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: colors.text, false: colors.borderStrong }}
        thumbColor="#fff"
      />
    </View>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg },
  h1: { fontSize: 26, fontWeight: "800", color: colors.text, letterSpacing: -0.4 },
  sub: { fontSize: 14, color: colors.soft, marginTop: 4, marginBottom: spacing(4) },
  card: {
    backgroundColor: colors.card,
    padding: spacing(4),
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border
  },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: spacing(3),
    paddingBottom: spacing(2),
    borderBottomWidth: 1,
    borderBottomColor: colors.border
  },
  sectionHeadText: { fontSize: 14, fontWeight: "800", color: colors.text, letterSpacing: -0.2 },

  label: {
    fontSize: 12,
    color: colors.soft,
    marginTop: spacing(1),
    marginBottom: 6,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.4
  },
  boxInput: {
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.bgAlt,
    fontWeight: "500"
  },

  seatRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    backgroundColor: colors.bgAlt,
    paddingHorizontal: 8,
    height: 50
  },
  seatBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border
  },
  seatVal: { fontSize: 16, fontWeight: "700", color: colors.text, minWidth: 20, textAlign: "center" },

  seatGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  seatChip: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgAlt
  },
  seatChipActive: {
    borderColor: colors.text,
    backgroundColor: colors.text
  },
  seatChipText: { fontSize: 14, fontWeight: "700", color: colors.text },
  seatChipTextActive: { color: colors.primaryText },

  segmentRow: {
    flexDirection: "row",
    backgroundColor: colors.bgAlt,
    borderRadius: radii.md,
    padding: 4,
    borderWidth: 1.5,
    borderColor: colors.borderStrong
  },
  segmentBtn: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 10,
    borderRadius: radii.md
  },
  segmentBtnActive: {
    backgroundColor: colors.text
  },
  segmentText: { fontSize: 13, fontWeight: "700", color: colors.text },
  segmentTextActive: { color: colors.primaryText },

  btn: {
    marginTop: spacing(5),
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: 16,
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    gap: 8
  },
  btnText: { color: colors.primaryText, fontWeight: "700", fontSize: 16, letterSpacing: -0.2 },
  note: { color: colors.soft, fontSize: 12, marginTop: spacing(3), lineHeight: 18 },
  hint: {
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    marginTop: spacing(3),
    backgroundColor: colors.bgAlt,
    padding: 10,
    borderRadius: radii.sm
  },
  hintText: { color: colors.text, fontSize: 12, flex: 1 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: spacing(3),
    paddingVertical: 4
  },
  bullet: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: spacing(3) },
  bulletIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.bgAlt,
    alignItems: "center",
    justifyContent: "center"
  },
  bulletText: { color: colors.text, fontSize: 14, flex: 1 }
});
