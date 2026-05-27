import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Switch,
  Image,
  KeyboardAvoidingView,
  Platform
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { alert } from "@/components/AlertHost";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { CityPicker, City } from "@/components/CityPicker";
import { DateField } from "@/components/DateField";
import { TimeField } from "@/components/TimeField";
import { call } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { locateAndResolve, ResolvedLocation } from "@/utils/location";
import { absoluteFileUrl, pickAndUploadImage, pickAndUploadImages } from "@/utils/upload";
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
  photos?: string[];
  license_plate?: string | null;
};

type ExistingDriverProfile = {
  name?: string;
  full_name?: string;
  bio?: string;
  license_number?: string | null;
  license_expiry?: string | null;
  preferences_music?: "Quiet" | "Some" | "Loud";
  preferences_chat?: "Quiet" | "Some" | "Chatty";
  preferences_smoking?: number;
  preferences_pets?: number;
} | null;

type DriverState = {
  vehicles: ExistingVehicle[];
  driver_profile: ExistingDriverProfile;
  driver_photo?: string | null;
  can_publish: boolean;
};

const MAX_CAR_PHOTOS = 5;

type Step = "trip" | "car" | "driver" | "prefs";
const STEPS: { id: Step; label: string; icon: any }[] = [
  { id: "trip", label: "Trip", icon: "navigate-outline" },
  { id: "car", label: "Car", icon: "car-sport-outline" },
  { id: "driver", label: "Driver", icon: "person-circle-outline" },
  { id: "prefs", label: "Preferences", icon: "options-outline" }
];

const MUSIC_OPTIONS: Array<"Quiet" | "Some" | "Loud"> = ["Quiet", "Some", "Loud"];
const CHAT_OPTIONS: Array<"Quiet" | "Some" | "Chatty"> = ["Quiet", "Some", "Chatty"];
const SEAT_OPTIONS = Array.from({ length: 12 }, (_, i) => i + 1);
const CURRENT_YEAR = new Date().getFullYear();

export function PublishScreen() {
  const nav = useNavigation<Nav>();
  const { profile } = useAuth();

  // Step
  const [step, setStep] = useState<Step>("trip");
  const scrollRef = useRef<ScrollView | null>(null);

  // Trip
  const [origin, setOrigin] = useState<City | null>(null);
  const [destination, setDestination] = useState<City | null>(null);
  const [date, setDate] = useState<Date | null>(null);
  const [time, setTime] = useState<Date | null>(null);
  const [seats, setSeats] = useState(3);
  const [price, setPrice] = useState("");
  const [instant, setInstant] = useState(true);
  const [womenOnly, setWomenOnly] = useState(false);
  const [description, setDescription] = useState("");
  const [suggest, setSuggest] = useState<PriceSuggest | null>(null);

  // Car
  const [carMake, setCarMake] = useState("");
  const [carModel, setCarModel] = useState("");
  const [carYear, setCarYear] = useState("");
  const [carColor, setCarColor] = useState("");
  const [carSeats, setCarSeats] = useState<number>(4);
  const [carPlate, setCarPlate] = useState("");
  const [carPhotos, setCarPhotos] = useState<string[]>([]);
  const [carPhotosBusy, setCarPhotosBusy] = useState(false);

  // Driver
  const [driverName, setDriverName] = useState("");
  const [driverBio, setDriverBio] = useState("");
  const [licenseNumber, setLicenseNumber] = useState("");
  const [licenseExpiry, setLicenseExpiry] = useState<Date | null>(null);
  const [driverPhoto, setDriverPhoto] = useState<string | null>(null);
  const [driverPhotoBusy, setDriverPhotoBusy] = useState(false);

  // Preferences
  const [prefMusic, setPrefMusic] = useState<"Quiet" | "Some" | "Loud">("Some");
  const [prefChat, setPrefChat] = useState<"Quiet" | "Some" | "Chatty">("Some");
  const [prefSmoking, setPrefSmoking] = useState(false);
  const [prefPets, setPrefPets] = useState(false);

  // Lifecycle
  const [busy, setBusy] = useState(false);
  const [driverState, setDriverState] = useState<DriverState | null>(null);
  const [enrolling, setEnrolling] = useState(false);

  // Device geolocation context — resolved once on first mount via the
  // backend's OpenCage proxy so the API key never ships in the bundle.
  // Surfaced through the <AutoLocatePill> so the user can *explicitly*
  // apply it to the From field; we never silently overwrite the field
  // because the device's city often doesn't match the trip the driver
  // wants to publish.
  const [autoLoc, setAutoLoc] = useState<ResolvedLocation | null>(null);
  const [locating, setLocating] = useState(true);

  useEffect(() => {
    loadDriverState();
    const initial = defaultDeparture();
    setDate(initial);
    setTime(initial);
  }, []);

  // Auto-fetch the device location once on mount so we can offer
  // "Use my current location" without a tap and seed the origin city.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loc = await locateAndResolve();
        if (cancelled) return;
        setLocating(false);
        if (!loc) return;
        setAutoLoc(loc);
      } catch {
        if (!cancelled) setLocating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // NOTE: we deliberately do NOT auto-seed the From / Pickup field from
  // the device fix.  GPS is helpful context but the city we resolve from
  // it isn't always what the driver actually wants to publish (think:
  // they're at home in Pune planning a Mumbai → Goa trip).  The
  // <AutoLocatePill> still surfaces the resolved location and a "View on
  // map" link, but applying it is now an explicit user action via
  // `reapplyAutoLocation()`.

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
      // License plate is decrypted server-side and returned only to
      // the row owner — see mobile.my_vehicles_summary.
      if (!carPlate && v.license_plate) setCarPlate(v.license_plate);
      if (carPhotos.length === 0 && Array.isArray(v.photos) && v.photos.length > 0) {
        setCarPhotos(v.photos.slice(0, MAX_CAR_PHOTOS));
      }
    }
    if (!driverPhoto && driverState.driver_photo) {
      setDriverPhoto(driverState.driver_photo);
    }
    const dp = driverState.driver_profile;
    if (dp) {
      if (!driverName) setDriverName(dp.full_name || profile?.full_name || "");
      if (!driverBio) setDriverBio(dp.bio || "");
      if (!licenseNumber && dp.license_number) setLicenseNumber(dp.license_number);
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
      /* re-checked by the publish_ride backend */
    }
  }

  // -- Photo handlers ------------------------------------------------------
  // Both pickers store the relative `/files/...` URL the upload endpoint
  // returns.  The publish payload sends these straight through to the
  // server; we only resolve them to absolute URLs at render time via
  // absoluteFileUrl().

  async function pickDriverPhoto(source: "library" | "camera") {
    setDriverPhotoBusy(true);
    try {
      const f = await pickAndUploadImage({
        source,
        allowsEditing: true,
        quality: 0.7,
        isPrivate: false
      });
      if (f?.fileUrl) setDriverPhoto(f.fileUrl);
    } catch (e: any) {
      alert("Couldn't upload", e?.message ?? "Try a different photo.");
    } finally {
      setDriverPhotoBusy(false);
    }
  }

  function chooseDriverPhotoSource() {
    alert("Driver portrait", "How would you like to add your photo?", [
      { text: "Take photo", onPress: () => pickDriverPhoto("camera") },
      { text: "Pick from gallery", onPress: () => pickDriverPhoto("library") },
      ...(driverPhoto
        ? [{ text: "Remove", style: "destructive" as const, onPress: () => setDriverPhoto(null) }]
        : []),
      { text: "Cancel", style: "cancel" as const }
    ]);
  }

  async function addCarPhotos() {
    const room = MAX_CAR_PHOTOS - carPhotos.length;
    if (room <= 0) {
      alert("Limit reached", `You can attach up to ${MAX_CAR_PHOTOS} car photos.`);
      return;
    }
    setCarPhotosBusy(true);
    try {
      const files = await pickAndUploadImages(room, { quality: 0.7, isPrivate: false });
      const urls = files.map((f) => f.fileUrl).filter(Boolean);
      if (urls.length > 0) setCarPhotos((prev) => [...prev, ...urls].slice(0, MAX_CAR_PHOTOS));
    } finally {
      setCarPhotosBusy(false);
    }
  }

  async function takeCarPhoto() {
    if (carPhotos.length >= MAX_CAR_PHOTOS) {
      alert("Limit reached", `You can attach up to ${MAX_CAR_PHOTOS} car photos.`);
      return;
    }
    setCarPhotosBusy(true);
    try {
      const f = await pickAndUploadImage({
        source: "camera",
        quality: 0.7,
        isPrivate: false
      });
      if (f?.fileUrl) setCarPhotos((prev) => [...prev, f.fileUrl].slice(0, MAX_CAR_PHOTOS));
    } catch (e: any) {
      alert("Couldn't upload", e?.message ?? "Try a different photo.");
    } finally {
      setCarPhotosBusy(false);
    }
  }

  function removeCarPhoto(idx: number) {
    setCarPhotos((prev) => prev.filter((_, i) => i !== idx));
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
      .catch(() => {/* network blip */});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, destination]);

  // Don't let the ride seats exceed what the car holds.
  const maxRideSeats = useMemo(() => Math.min(12, Math.max(1, carSeats || 4)), [carSeats]);
  useEffect(() => {
    if (seats > maxRideSeats) setSeats(maxRideSeats);
  }, [maxRideSeats, seats]);

  function gotoStep(next: Step) {
    setStep(next);
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: 0, animated: true }));
  }

  async function becomeDriver() {
    setEnrolling(true);
    try {
      await call("rideshare.api.onboarding.quick_become_driver", {
        full_name: profile?.full_name || profile?.first_name
      });
      await loadDriverState();
    } catch (e: any) {
      alert("Couldn't enrol you", e?.message ?? "Try again.");
    } finally {
      setEnrolling(false);
    }
  }

  // ---- per-step validation -----------------------------------------------
  function validateStep(s: Step): string | null {
    if (s === "trip") {
      if (!origin || !destination) return "Add both pickup and drop locations.";
      if (origin.id === destination.id) return "Origin and destination can't be the same city.";
      if (!date || !time) return "Select both a date and a time.";
      const departure = combineDateAndTime(date, time);
      if (departure.getTime() < Date.now() - 60 * 1000) return "Departure must be in the future.";
      if (!price || parseFloat(price) <= 0) return "Enter a price per seat.";
    }
    if (s === "car") {
      if (!carMake.trim() || !carModel.trim()) return "Add your car's make and model.";
      if (!carYear.trim() || isNaN(parseInt(carYear)) || parseInt(carYear) < 1980 || parseInt(carYear) > CURRENT_YEAR + 1) {
        return "Enter a valid car year.";
      }
      if (!carPlate.trim()) return "Add your car's license plate.";
    }
    if (s === "driver") {
      if (!driverName.trim()) return "Add your full name.";
      if (!licenseNumber.trim()) return "Add your driving licence number.";
      if (!licenseExpiry) return "Pick your driving licence expiry date.";
      if (licenseExpiry.getTime() < Date.now()) return "Driving licence has expired — please renew before publishing.";
    }
    return null;
  }

  function next() {
    const problem = validateStep(step);
    if (problem) {
      alert("Almost there", problem);
      return;
    }
    if (step === "trip") gotoStep("car");
    else if (step === "car") gotoStep("driver");
    else if (step === "driver") gotoStep("prefs");
    else publish();
  }

  function back() {
    if (step === "car") gotoStep("trip");
    else if (step === "driver") gotoStep("car");
    else if (step === "prefs") gotoStep("driver");
  }

  async function publish() {
    // Re-run all validations one final time.
    for (const s of ["trip", "car", "driver"] as Step[]) {
      const problem = validateStep(s);
      if (problem) {
        alert("Almost there", problem);
        gotoStep(s);
        return;
      }
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
          license_plate: carPlate.trim(),
          photos: carPhotos
        },
        driver: {
          full_name: driverName.trim(),
          bio: driverBio.trim(),
          license_number: licenseNumber.trim(),
          license_expiry: licenseExpiry ? toApiDate(licenseExpiry) : null,
          photo: driverPhoto || null
        },
        preferences: {
          music: prefMusic,
          chat: prefChat,
          smoking: prefSmoking ? 1 : 0,
          pets: prefPets ? 1 : 0
        }
      };
      await call("rideshare.api.rides.publish_ride", { payload: JSON.stringify(payload) });
      alert("Ride published 🎉", "Passengers can now find and book it.");
      // Reset only the trip fields; keep car/driver/preferences populated.
      setOrigin(null);
      setDestination(null);
      const nextDt = defaultDeparture();
      setDate(nextDt);
      setTime(nextDt);
      setPrice("");
      setDescription("");
      setStep("trip");
      nav.navigate("Tabs" as any);
    } catch (e: any) {
      alert("Couldn't publish", e?.message ?? "Try again.");
    } finally {
      setBusy(false);
    }
  }

  // Driver enrolment gate — non-drivers see a friendly welcome first.
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
            <Bullet icon="shield-checkmark-outline" text="Live location is shared only with riders" />

            <TouchableOpacity
              style={[s.btnFull, enrolling && { opacity: 0.6 }]}
              onPress={becomeDriver}
              disabled={enrolling}
              activeOpacity={0.85}
            >
              {enrolling ? (
                <ActivityIndicator color={colors.primaryText} />
              ) : (
                <>
                  <Text style={s.btnText}>Get started</Text>
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

  const stepIndex = STEPS.findIndex((x) => x.id === step);
  const isLastStep = step === "prefs";

  return (
    <SafeAreaView style={s.shell} edges={["top"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <View style={s.headerWrap}>
          <Text style={s.h1}>Publish a ride</Text>
          <Text style={s.sub}>
            Step {stepIndex + 1} of {STEPS.length} · {STEPS[stepIndex].label}
          </Text>
          <StepDots stepIndex={stepIndex} />
        </View>

        <ScrollView
          ref={scrollRef}
          contentContainerStyle={{ padding: spacing(4), paddingBottom: spacing(12) }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {step === "trip" ? (
            <TripStep
              origin={origin}
              setOrigin={setOrigin}
              destination={destination}
              setDestination={setDestination}
              date={date}
              setDate={setDate}
              time={time}
              setTime={setTime}
              seats={seats}
              setSeats={setSeats}
              maxRideSeats={maxRideSeats}
              price={price}
              setPrice={setPrice}
              suggest={suggest}
              instant={instant}
              setInstant={setInstant}
              womenOnly={womenOnly}
              setWomenOnly={setWomenOnly}
              description={description}
              setDescription={setDescription}
              autoLoc={autoLoc}
              locating={locating}
              onViewLocationOnMap={() => nav.navigate("MyLocation", { role: "driver" })}
            />
          ) : null}

          {step === "car" ? (
            <CarStep
              carMake={carMake} setCarMake={setCarMake}
              carModel={carModel} setCarModel={setCarModel}
              carYear={carYear} setCarYear={setCarYear}
              carColor={carColor} setCarColor={setCarColor}
              carSeats={carSeats} setCarSeats={setCarSeats}
              carPlate={carPlate} setCarPlate={setCarPlate}
              carPhotos={carPhotos}
              carPhotosBusy={carPhotosBusy}
              onAddCarPhotos={addCarPhotos}
              onTakeCarPhoto={takeCarPhoto}
              onRemoveCarPhoto={removeCarPhoto}
            />
          ) : null}

          {step === "driver" ? (
            <DriverStep
              driverName={driverName} setDriverName={setDriverName}
              driverBio={driverBio} setDriverBio={setDriverBio}
              licenseNumber={licenseNumber} setLicenseNumber={setLicenseNumber}
              licenseExpiry={licenseExpiry} setLicenseExpiry={setLicenseExpiry}
              driverPhoto={driverPhoto}
              driverPhotoBusy={driverPhotoBusy}
              onPickDriverPhoto={chooseDriverPhotoSource}
            />
          ) : null}

          {step === "prefs" ? (
            <PrefsStep
              prefMusic={prefMusic} setPrefMusic={setPrefMusic}
              prefChat={prefChat} setPrefChat={setPrefChat}
              prefSmoking={prefSmoking} setPrefSmoking={setPrefSmoking}
              prefPets={prefPets} setPrefPets={setPrefPets}
            />
          ) : null}
        </ScrollView>

        <View style={s.footer}>
          {step !== "trip" ? (
            <TouchableOpacity style={s.backBtn} onPress={back} activeOpacity={0.8}>
              <Ionicons name="chevron-back" size={18} color={colors.text} />
              <Text style={s.backBtnText}>Back</Text>
            </TouchableOpacity>
          ) : <View style={{ width: 90 }} />}
          <TouchableOpacity
            style={[s.nextBtn, busy && { opacity: 0.6 }]}
            onPress={next}
            disabled={busy}
            activeOpacity={0.85}
          >
            {busy ? (
              <ActivityIndicator color={colors.primaryText} />
            ) : (
              <>
                <Text style={s.nextBtnText}>{isLastStep ? "Publish ride" : "Continue"}</Text>
                <Ionicons
                  name={isLastStep ? "checkmark" : "arrow-forward"}
                  size={18}
                  color={colors.primaryText}
                />
              </>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Step components
// ---------------------------------------------------------------------------

function TripStep(props: {
  origin: City | null; setOrigin: (c: City | null) => void;
  destination: City | null; setDestination: (c: City | null) => void;
  date: Date | null; setDate: (d: Date | null) => void;
  time: Date | null; setTime: (d: Date | null) => void;
  seats: number; setSeats: (n: number) => void; maxRideSeats: number;
  price: string; setPrice: (s: string) => void;
  suggest: PriceSuggest | null;
  instant: boolean; setInstant: (b: boolean) => void;
  womenOnly: boolean; setWomenOnly: (b: boolean) => void;
  description: string; setDescription: (s: string) => void;
  autoLoc: ResolvedLocation | null;
  locating: boolean;
  onViewLocationOnMap: () => void;
}) {
  return (
    <View style={[s.card, shadow.card]}>
      <AutoLocatePill
        autoLoc={props.autoLoc}
        locating={props.locating}
        onViewMap={props.onViewLocationOnMap}
      />
      <CityPicker
        label="From *"
        value={props.origin}
        onChange={props.setOrigin}
        placeholder="Pickup city"
        iconName="radio-button-on"
        excludeId={props.destination?.id}
      />
      <CityPicker
        label="To *"
        value={props.destination}
        onChange={props.setDestination}
        placeholder="Drop-off city"
        iconName="location"
        excludeId={props.origin?.id}
      />

      <View style={{ flexDirection: "row", gap: spacing(3), marginTop: spacing(2) }}>
        <View style={{ flex: 1 }}>
          <DateField label="Date *" value={props.date} onChange={props.setDate} />
        </View>
        <View style={{ flex: 1 }}>
          <TimeField label="Time *" value={props.time} onChange={props.setTime} />
        </View>
      </View>

      <View style={{ flexDirection: "row", gap: spacing(3), marginTop: spacing(3) }}>
        <View style={{ flex: 1 }}>
          <FieldLabel required>Seats offered</FieldLabel>
          <View style={s.seatRow}>
            <TouchableOpacity
              onPress={() => props.setSeats(Math.max(1, props.seats - 1))}
              style={s.seatBtn}
              hitSlop={6}
            >
              <Ionicons name="remove" size={16} color={colors.text} />
            </TouchableOpacity>
            <Text style={s.seatVal}>{props.seats}</Text>
            <TouchableOpacity
              onPress={() => props.setSeats(Math.min(props.maxRideSeats, props.seats + 1))}
              style={s.seatBtn}
              hitSlop={6}
            >
              <Ionicons name="add" size={16} color={colors.text} />
            </TouchableOpacity>
          </View>
        </View>
        <View style={{ flex: 1 }}>
          <FieldLabel required>Price / seat (₹)</FieldLabel>
          <TextInput
            style={s.boxInput}
            value={props.price}
            onChangeText={props.setPrice}
            keyboardType="number-pad"
            placeholder={props.suggest ? String(props.suggest.suggested_price) : "0"}
            placeholderTextColor={colors.mute}
          />
        </View>
      </View>

      {props.suggest ? (
        <View style={s.hint}>
          <Ionicons name="sparkles-outline" size={14} color={colors.soft} />
          <Text style={s.hintText}>
            Suggested ₹{props.suggest.suggested_price} · {props.suggest.distance_km} km · ~
            {props.suggest.duration_minutes} min · fair range ₹{props.suggest.min_price}–₹
            {props.suggest.max_price}
          </Text>
        </View>
      ) : null}

      <Toggle label="Instant booking" value={props.instant} onChange={props.setInstant} icon="flash-outline" />
      <Toggle label="Women only" value={props.womenOnly} onChange={props.setWomenOnly} icon="female-outline" />

      <FieldLabel>Notes for passengers</FieldLabel>
      <TextInput
        style={[s.boxInput, { height: 88, textAlignVertical: "top" }]}
        value={props.description}
        onChangeText={props.setDescription}
        placeholder="Pickup spot, luggage limits, etc."
        placeholderTextColor={colors.mute}
        multiline
      />
    </View>
  );
}

function CarStep(props: {
  carMake: string; setCarMake: (s: string) => void;
  carModel: string; setCarModel: (s: string) => void;
  carYear: string; setCarYear: (s: string) => void;
  carColor: string; setCarColor: (s: string) => void;
  carSeats: number; setCarSeats: (n: number) => void;
  carPlate: string; setCarPlate: (s: string) => void;
  carPhotos: string[];
  carPhotosBusy: boolean;
  onAddCarPhotos: () => void;
  onTakeCarPhoto: () => void;
  onRemoveCarPhoto: (idx: number) => void;
}) {
  return (
    <View style={[s.card, shadow.card]}>
      <View style={{ flexDirection: "row", gap: spacing(3) }}>
        <View style={{ flex: 1 }}>
          <FieldLabel required>Make</FieldLabel>
          <TextInput
            style={s.boxInput}
            value={props.carMake}
            onChangeText={props.setCarMake}
            placeholder="Maruti"
            placeholderTextColor={colors.mute}
            autoCapitalize="words"
          />
        </View>
        <View style={{ flex: 1 }}>
          <FieldLabel required>Model</FieldLabel>
          <TextInput
            style={s.boxInput}
            value={props.carModel}
            onChangeText={props.setCarModel}
            placeholder="Swift"
            placeholderTextColor={colors.mute}
            autoCapitalize="words"
          />
        </View>
      </View>

      <View style={{ flexDirection: "row", gap: spacing(3), marginTop: spacing(3) }}>
        <View style={{ flex: 1 }}>
          <FieldLabel required>Year</FieldLabel>
          <TextInput
            style={s.boxInput}
            value={props.carYear}
            onChangeText={props.setCarYear}
            placeholder={String(CURRENT_YEAR)}
            placeholderTextColor={colors.mute}
            keyboardType="number-pad"
            maxLength={4}
          />
        </View>
        <View style={{ flex: 1 }}>
          <FieldLabel>Color</FieldLabel>
          <TextInput
            style={s.boxInput}
            value={props.carColor}
            onChangeText={props.setCarColor}
            placeholder="White"
            placeholderTextColor={colors.mute}
            autoCapitalize="words"
          />
        </View>
      </View>

      <FieldLabel required style={{ marginTop: spacing(3) }}>
        Passenger seats (1–12)
      </FieldLabel>
      <SeatGridPicker value={props.carSeats} onChange={props.setCarSeats} />

      <FieldLabel required style={{ marginTop: spacing(3) }}>License plate</FieldLabel>
      <TextInput
        style={s.boxInput}
        value={props.carPlate}
        onChangeText={(t) => props.setCarPlate(t.toUpperCase())}
        placeholder="DL01AB1234"
        placeholderTextColor={colors.mute}
        autoCapitalize="characters"
        autoCorrect={false}
      />

      <FieldLabel style={{ marginTop: spacing(3) }}>
        Car photos · {props.carPhotos.length}/{MAX_CAR_PHOTOS}
      </FieldLabel>
      <Text style={s.photoHint}>
        Add a few angles — exterior, interior, the boot. Bookers see these before
        confirming a seat.
      </Text>
      <View style={s.photoGrid}>
        {props.carPhotos.map((url, idx) => {
          const abs = absoluteFileUrl(url);
          return (
            <View key={`${url}-${idx}`} style={s.photoTile}>
              {abs ? <Image source={{ uri: abs }} style={s.photoTileImg} /> : null}
              <TouchableOpacity
                style={s.photoTileRm}
                onPress={() => props.onRemoveCarPhoto(idx)}
                hitSlop={6}
              >
                <Ionicons name="close" size={14} color={colors.primaryText} />
              </TouchableOpacity>
            </View>
          );
        })}
        {props.carPhotos.length < MAX_CAR_PHOTOS ? (
          <TouchableOpacity
            style={[s.photoAdd, props.carPhotosBusy && { opacity: 0.6 }]}
            onPress={props.onAddCarPhotos}
            disabled={props.carPhotosBusy}
            activeOpacity={0.85}
          >
            {props.carPhotosBusy ? (
              <ActivityIndicator color={colors.text} />
            ) : (
              <>
                <Ionicons name="images-outline" size={22} color={colors.text} />
                <Text style={s.photoAddText}>Add</Text>
              </>
            )}
          </TouchableOpacity>
        ) : null}
      </View>
      {props.carPhotos.length < MAX_CAR_PHOTOS ? (
        <TouchableOpacity
          style={s.photoCameraBtn}
          onPress={props.onTakeCarPhoto}
          disabled={props.carPhotosBusy}
          activeOpacity={0.85}
        >
          <Ionicons name="camera-outline" size={16} color={colors.text} />
          <Text style={s.photoCameraText}>Take a photo with the camera</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function DriverStep(props: {
  driverName: string; setDriverName: (s: string) => void;
  driverBio: string; setDriverBio: (s: string) => void;
  licenseNumber: string; setLicenseNumber: (s: string) => void;
  licenseExpiry: Date | null; setLicenseExpiry: (d: Date | null) => void;
  driverPhoto: string | null;
  driverPhotoBusy: boolean;
  onPickDriverPhoto: () => void;
}) {
  const portraitUrl = absoluteFileUrl(props.driverPhoto);
  return (
    <View style={[s.card, shadow.card]}>
      <View style={s.portraitRow}>
        <TouchableOpacity
          style={s.portraitWrap}
          onPress={props.onPickDriverPhoto}
          disabled={props.driverPhotoBusy}
          activeOpacity={0.85}
        >
          {portraitUrl ? (
            <Image source={{ uri: portraitUrl }} style={s.portraitImg} />
          ) : (
            <View style={s.portraitPlaceholder}>
              <Ionicons name="person" size={30} color={colors.soft} />
            </View>
          )}
          <View style={s.portraitBadge}>
            {props.driverPhotoBusy ? (
              <ActivityIndicator color={colors.primaryText} size="small" />
            ) : (
              <Ionicons
                name={portraitUrl ? "camera-reverse" : "camera"}
                size={14}
                color={colors.primaryText}
              />
            )}
          </View>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.portraitTitle}>Driver portrait</Text>
          <Text style={s.portraitSub}>
            Bookers see this on the ride detail screen. A clear, friendly photo
            helps them recognise you at the pickup.
          </Text>
          <TouchableOpacity
            style={s.portraitBtn}
            onPress={props.onPickDriverPhoto}
            disabled={props.driverPhotoBusy}
            activeOpacity={0.85}
          >
            <Text style={s.portraitBtnText}>
              {portraitUrl ? "Change photo" : "Add photo"}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <FieldLabel required style={{ marginTop: spacing(3) }}>Full name</FieldLabel>
      <TextInput
        style={s.boxInput}
        value={props.driverName}
        onChangeText={props.setDriverName}
        placeholder="As on your driving licence"
        placeholderTextColor={colors.mute}
        autoCapitalize="words"
      />

      <FieldLabel style={{ marginTop: spacing(3) }}>Bio (optional)</FieldLabel>
      <TextInput
        style={[s.boxInput, { height: 72, textAlignVertical: "top" }]}
        value={props.driverBio}
        onChangeText={props.setDriverBio}
        placeholder="Tell passengers a bit about yourself."
        placeholderTextColor={colors.mute}
        multiline
      />

      <FieldLabel required style={{ marginTop: spacing(3) }}>Driving licence number</FieldLabel>
      <TextInput
        style={s.boxInput}
        value={props.licenseNumber}
        onChangeText={props.setLicenseNumber}
        placeholder="e.g. DL-1420110012345"
        placeholderTextColor={colors.mute}
        autoCapitalize="characters"
        autoCorrect={false}
      />

      <View style={{ marginTop: spacing(3) }}>
        <DateField
          label="Licence expiry *"
          value={props.licenseExpiry}
          onChange={(d: Date | null) => props.setLicenseExpiry(d as any)}
          minimumDate={new Date()}
        />
      </View>
    </View>
  );
}

function PrefsStep(props: {
  prefMusic: "Quiet" | "Some" | "Loud"; setPrefMusic: (v: "Quiet" | "Some" | "Loud") => void;
  prefChat: "Quiet" | "Some" | "Chatty"; setPrefChat: (v: "Quiet" | "Some" | "Chatty") => void;
  prefSmoking: boolean; setPrefSmoking: (b: boolean) => void;
  prefPets: boolean; setPrefPets: (b: boolean) => void;
}) {
  return (
    <View style={[s.card, shadow.card]}>
      <FieldLabel>Music</FieldLabel>
      <SegmentPicker
        options={MUSIC_OPTIONS as readonly string[]}
        value={props.prefMusic}
        onChange={(v) => props.setPrefMusic(v as "Quiet" | "Some" | "Loud")}
      />

      <FieldLabel style={{ marginTop: spacing(3) }}>Chat</FieldLabel>
      <SegmentPicker
        options={CHAT_OPTIONS as readonly string[]}
        value={props.prefChat}
        onChange={(v) => props.setPrefChat(v as "Quiet" | "Some" | "Chatty")}
      />

      <Toggle
        label="Smoking OK"
        value={props.prefSmoking}
        onChange={props.setPrefSmoking}
        icon="flame-outline"
      />
      <Toggle
        label="Pets OK"
        value={props.prefPets}
        onChange={props.setPrefPets}
        icon="paw-outline"
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

function AutoLocatePill({
  autoLoc,
  locating,
  onViewMap
}: {
  autoLoc: ResolvedLocation | null;
  locating: boolean;
  /** Tap target — opens the live-location map.  Intentionally NOT
   *  wired to the From/Pickup field anymore: GPS is shown for context
   *  only, the user picks the actual origin city by hand. */
  onViewMap?: () => void;
}) {
  if (locating) {
    return (
      <View style={s.locatePill}>
        <ActivityIndicator size="small" color={colors.text} />
        <Text style={s.locatePillText}>Detecting your current location…</Text>
      </View>
    );
  }
  if (!autoLoc) {
    return (
      <View style={s.locatePill}>
        <Ionicons name="location-outline" size={16} color={colors.soft} />
        <Text style={[s.locatePillText, { color: colors.soft }]} numberOfLines={1}>
          Allow location access for live trip features
        </Text>
      </View>
    );
  }
  const label = autoLoc.city || autoLoc.area || autoLoc.address || "your location";
  return (
    <TouchableOpacity
      style={[s.locatePill, s.locatePillReady]}
      onPress={onViewMap}
      activeOpacity={0.85}
      disabled={!onViewMap}
    >
      <Ionicons name="locate" size={16} color={colors.primaryText} />
      <Text style={[s.locatePillText, s.locatePillTextReady]} numberOfLines={1}>
        You're near {label}
      </Text>
      {onViewMap ? (
        <Ionicons name="map-outline" size={14} color={colors.primaryText} />
      ) : null}
    </TouchableOpacity>
  );
}

function FieldLabel({
  children,
  required,
  style
}: {
  children: React.ReactNode;
  required?: boolean;
  style?: any;
}) {
  return (
    <Text style={[s.label, style]}>
      {children}
      {required ? <Text style={{ color: colors.danger }}>  *</Text> : null}
    </Text>
  );
}

function StepDots({ stepIndex }: { stepIndex: number }) {
  return (
    <View style={s.dotsRow}>
      {STEPS.map((step, i) => (
        <React.Fragment key={step.id}>
          <View
            style={[
              s.dot,
              i < stepIndex && s.dotDone,
              i === stepIndex && s.dotActive
            ]}
          >
            {i < stepIndex ? (
              <Ionicons name="checkmark" size={11} color={colors.primaryText} />
            ) : (
              <Text style={[s.dotText, i === stepIndex && { color: colors.primaryText }]}>{i + 1}</Text>
            )}
          </View>
          {i < STEPS.length - 1 ? (
            <View style={[s.dotLine, i < stepIndex && { backgroundColor: colors.text }]} />
          ) : null}
        </React.Fragment>
      ))}
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

function Toggle({
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
    <View style={s.toggleRow}>
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
  headerWrap: {
    paddingHorizontal: spacing(4),
    paddingTop: spacing(2),
    paddingBottom: spacing(3),
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card
  },
  h1: { fontSize: 24, fontWeight: "800", color: colors.text, letterSpacing: -0.4 },
  sub: { fontSize: 13, color: colors.soft, marginTop: 4 },

  dotsRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing(3),
    gap: 4
  },
  dot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.bgAlt,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center"
  },
  dotActive: {
    backgroundColor: colors.text,
    borderColor: colors.text
  },
  dotDone: {
    backgroundColor: colors.text,
    borderColor: colors.text
  },
  dotText: { fontSize: 12, fontWeight: "700", color: colors.soft },
  dotLine: {
    flex: 1,
    height: 2,
    backgroundColor: colors.border
  },

  card: {
    backgroundColor: colors.card,
    padding: spacing(4),
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border
  },

  locatePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.bgAlt,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 999,
    marginBottom: spacing(3)
  },
  locatePillReady: {
    backgroundColor: colors.primary,
    borderColor: colors.primary
  },
  locatePillText: { flex: 1, fontSize: 12, color: colors.text, fontWeight: "700" },
  locatePillTextReady: { color: colors.primaryText },
  locateMapLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingTop: 6,
    paddingBottom: 0,
    alignSelf: "flex-end"
  },
  locateMapLinkText: { color: colors.brand, fontSize: 11, fontWeight: "700" },

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

  toggleRow: {
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
  bulletText: { color: colors.text, fontSize: 14, flex: 1 },

  btnFull: {
    marginTop: spacing(3),
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

  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing(4),
    paddingVertical: spacing(3),
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
    gap: 12
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.card,
    minWidth: 90,
    justifyContent: "center"
  },
  backBtnText: { color: colors.text, fontWeight: "700", fontSize: 14 },
  nextBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: 999,
    paddingVertical: 14
  },
  nextBtnText: { color: colors.primaryText, fontWeight: "700", fontSize: 15 },

  // Driver portrait picker
  portraitRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingBottom: spacing(3),
    borderBottomWidth: 1,
    borderBottomColor: colors.border
  },
  portraitWrap: { width: 84, height: 84, position: "relative" },
  portraitImg: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: colors.bgAlt
  },
  portraitPlaceholder: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: colors.bgAlt,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderStyle: "dashed"
  },
  portraitBadge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.card
  },
  portraitTitle: { fontSize: 14, fontWeight: "800", color: colors.text },
  portraitSub: { fontSize: 12, color: colors.soft, marginTop: 2, lineHeight: 17 },
  portraitBtn: {
    alignSelf: "flex-start",
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.bgAlt,
    borderWidth: 1,
    borderColor: colors.border
  },
  portraitBtnText: { fontSize: 12, fontWeight: "700", color: colors.text },

  // Car gallery
  photoHint: { fontSize: 12, color: colors.soft, marginBottom: 8, lineHeight: 17 },
  photoGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  photoTile: {
    width: 88,
    height: 88,
    borderRadius: radii.md,
    overflow: "hidden",
    backgroundColor: colors.bgAlt,
    position: "relative"
  },
  photoTileImg: { width: 88, height: 88, resizeMode: "cover" },
  photoTileRm: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "rgba(0,0,0,0.65)",
    alignItems: "center",
    justifyContent: "center"
  },
  photoAdd: {
    width: 88,
    height: 88,
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderStyle: "dashed",
    backgroundColor: colors.bgAlt,
    alignItems: "center",
    justifyContent: "center",
    gap: 4
  },
  photoAddText: { fontSize: 11, color: colors.text, fontWeight: "700" },
  photoCameraBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 10,
    paddingVertical: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card
  },
  photoCameraText: { fontSize: 12, fontWeight: "700", color: colors.text }
});
