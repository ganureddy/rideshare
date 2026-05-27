// Coordinate-safety helpers for react-native-maps.
//
// react-native-maps will *crash the entire app* on Android when its
// native side receives non-finite numbers (NaN / Infinity / null /
// undefined) for any of the lat/lng/region fields.  The crash bypasses
// the JS error boundary because it happens inside the native bridge,
// which is why every "the app just closes" report we've had so far
// involves opening a screen with a map.
//
// All map-rendering screens go through these helpers instead of
// dereferencing lat/lng fields directly.  The contract:
//
//   * `validLatLng(lat, lng)` — true only when both values are finite
//     numbers in legal ranges and not the meaningless 0/0 ("Null
//     Island") that Frappe likes to use as a placeholder.
//   * `validPoint(p)` — same, accepting a `{lat, lng}` shape.
//   * `safeRegion(points, fallback)` — return a region that fits all
//     valid points; fall back to `fallback` (or India centre) when
//     there are no usable points instead of producing NaN deltas.
//   * `safeCoord(p)` — return a `{latitude, longitude}` ready for a
//     Marker / Polyline coordinate prop, or `null` when the input is
//     bad.  Render the marker conditionally on the result so the
//     native side never sees NaN.

import type { LatLng as AStarLatLng } from "@/utils/astar";

export type Coord = { latitude: number; longitude: number };
export type LooseLatLng = {
  lat?: number | null;
  lng?: number | null;
} | null
  | undefined;

const INDIA_CENTRE: Coord = { latitude: 20.5937, longitude: 78.9629 };

export function validLatLng(lat: unknown, lng: unknown): lat is number {
  if (typeof lat !== "number" || typeof lng !== "number") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  // 0/0 is "Null Island" in the Atlantic — never a legitimate position
  // for a rideshare in India, and Frappe seeds it as a default when
  // City rows haven't been geocoded yet.
  if (lat === 0 && lng === 0) return false;
  return true;
}

export function validPoint(p: LooseLatLng): boolean {
  if (!p) return false;
  return validLatLng(p.lat, p.lng);
}

/** Convert a `{lat, lng}` to a map-ready `{latitude, longitude}`, or null. */
export function safeCoord(p: LooseLatLng): Coord | null {
  if (!validPoint(p)) return null;
  return { latitude: p!.lat as number, longitude: p!.lng as number };
}

/** Convert an A* lat/lng to map coord (assumes the input was validated). */
export function aStarCoord(p: AStarLatLng): Coord {
  return { latitude: p.lat, longitude: p.lng };
}

export type Region = Coord & { latitudeDelta: number; longitudeDelta: number };

/**
 * Build a `<MapView initialRegion={...}>` value that fits every valid
 * point in `points`.  Returns the explicit `fallback` (or India
 * centre) when no valid points are available.
 *
 * The deltas are clamped to a minimum of 0.05 so:
 *   * a single-point region zooms in without looking broken,
 *   * two near-identical points don't yield a zero-delta zoom that
 *     react-native-maps misinterprets.
 */
export function safeRegion(
  points: LooseLatLng[],
  fallback?: Coord
): Region {
  const valid = points.filter(validPoint) as Array<{ lat: number; lng: number }>;
  if (valid.length === 0) {
    const centre = fallback ?? INDIA_CENTRE;
    return {
      latitude: centre.latitude,
      longitude: centre.longitude,
      latitudeDelta: 0.5,
      longitudeDelta: 0.5
    };
  }
  let minLat = Infinity, maxLat = -Infinity;
  let minLng = Infinity, maxLng = -Infinity;
  for (const p of valid) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  const lat = (minLat + maxLat) / 2;
  const lng = (minLng + maxLng) / 2;
  const latitudeDelta = Math.max((maxLat - minLat) * 1.6, 0.05);
  const longitudeDelta = Math.max((maxLng - minLng) * 1.6, 0.05);
  return {
    latitude: lat,
    longitude: lng,
    latitudeDelta,
    longitudeDelta
  };
}
