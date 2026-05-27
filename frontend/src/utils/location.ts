// Helpers around the device GPS + the backend's reverse-geocode proxy.
//
// The backend (`rideshare.api.places.reverse_geocode`) talks to OpenCage
// using a server-side API key — this keeps the key out of the mobile
// bundle and lets ops swap providers without shipping a new APK.
//
// All helpers are non-throwing: they resolve to `null` on permission
// denial / network failure so callers can fall back to manual entry
// without wrapping every site in a try/catch.

import * as Location from "expo-location";
import { call } from "@/api/client";

export type Coords = {
  lat: number;
  lng: number;
  /** Reported accuracy in metres, when available. */
  accuracy?: number | null;
};

export type ResolvedLocation = Coords & {
  /** Reverse-geocoded postal address, e.g. "5 King Rd, Bengaluru, KA 560001". */
  address?: string | null;
  /** OpenCage's "formatted" string — usually identical to address. */
  formatted?: string | null;
  /** Best-effort city label (locality > town > village > county). */
  city?: string | null;
  state?: string | null;
  state_code?: string | null;
  state_district?: string | null;
  county?: string | null;
  country?: string | null;
  country_code?: string | null;
  /** Emoji flag for the country, when OpenCage returns one. */
  flag?: string | null;
  postcode?: string | null;
  suburb?: string | null;
  road?: string | null;
  road_type?: string | null;
  category?: string | null;
  type?: string | null;
  /** Smaller-grain locality: residential/neighbourhood/suburb/road. */
  area?: string | null;
  /** OpenCage 0–10 confidence score for the match. */
  confidence?: number | null;
  /** IANA timezone, e.g. "Asia/Kolkata". */
  timezone?: string | null;
};

let _permissionPromise: Promise<boolean> | null = null;

/** Ask for foreground permission once per process; remember the answer. */
export async function ensureLocationPermission(): Promise<boolean> {
  if (_permissionPromise) return _permissionPromise;
  _permissionPromise = (async () => {
    try {
      const existing = await Location.getForegroundPermissionsAsync();
      if (existing.granted) return true;
      const next = await Location.requestForegroundPermissionsAsync();
      return next.status === "granted";
    } catch {
      return false;
    }
  })();
  // Don't memoise denials forever — let the caller try again on next prompt.
  const ok = await _permissionPromise;
  if (!ok) _permissionPromise = null;
  return ok;
}

/** Get a single GPS fix, or `null` if permission is denied or it times out. */
export async function getCurrentCoords(opts?: {
  accuracy?: Location.LocationAccuracy;
}): Promise<Coords | null> {
  const granted = await ensureLocationPermission();
  if (!granted) return null;
  try {
    const pos = await Location.getCurrentPositionAsync({
      accuracy: opts?.accuracy ?? Location.Accuracy.Balanced
    });
    return {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy ?? null
    };
  } catch {
    return null;
  }
}

/** Reverse-geocode a coordinate via the backend (OpenCage by default). */
export async function reverseGeocode(
  coords: Coords
): Promise<ResolvedLocation | null> {
  try {
    const res = await call<Record<string, any>>(
      "rideshare.api.places.reverse_geocode",
      { lat: coords.lat, lng: coords.lng }
    );
    return {
      ...coords,
      address: res?.address ?? null,
      formatted: res?.formatted ?? res?.address ?? null,
      city: res?.city ?? null,
      state: res?.state ?? null,
      state_code: res?.state_code ?? null,
      state_district: res?.state_district ?? null,
      county: res?.county ?? null,
      country: res?.country ?? null,
      country_code: res?.country_code ?? null,
      flag: res?.flag ?? null,
      postcode: res?.postcode ?? null,
      suburb: res?.suburb ?? null,
      road: res?.road ?? null,
      road_type: res?.road_type ?? null,
      category: res?.category ?? null,
      type: res?.type ?? null,
      area: res?.area ?? null,
      confidence: typeof res?.confidence === "number" ? res.confidence : null,
      timezone: res?.timezone ?? null
    };
  } catch {
    return { ...coords, address: null, city: null, state: null, country: null };
  }
}

/** Convenience: GPS fix + reverse-geocode in one call. */
export async function locateAndResolve(): Promise<ResolvedLocation | null> {
  const coords = await getCurrentCoords({ accuracy: Location.Accuracy.High });
  if (!coords) return null;
  return reverseGeocode(coords);
}

/**
 * Build the OpenCage geocoding URL for a coordinate pair.
 *
 * Used purely for parity with the upstream API spec the product team
 * shared; the app itself talks to the backend proxy (so the API key
 * never ships in the bundle).  Useful for debug toasts / "view raw"
 * dialogs.
 */
export function opencageUrl(lat: number, lng: number, key: string): string {
  return `https://api.opencagedata.com/geocode/v1/json?q=${lat}+${lng}&key=${encodeURIComponent(key)}`;
}

/** Static OSM tile URL — handy for in-app HTML map fallbacks. */
export function osmStaticMapHtml(
  marker: Coords,
  opts?: { zoom?: number; height?: number }
): string {
  const zoom = opts?.zoom ?? 15;
  const h = opts?.height ?? 220;
  return `<!doctype html><html><head>
<meta name="viewport" content="initial-scale=1,maximum-scale=1,user-scalable=no" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>html,body,#m{margin:0;padding:0;height:${h}px;width:100%}</style>
</head><body>
<div id="m"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  const map = L.map('m').setView([${marker.lat}, ${marker.lng}], ${zoom});
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap'
  }).addTo(map);
  L.marker([${marker.lat}, ${marker.lng}]).addTo(map);
</script></body></html>`;
}

/**
 * Build a richer Leaflet+OpenStreetMap HTML page meant for embedding in
 * a React Native WebView.
 *
 * Renders a custom marker (car or person SVG bubble) at the supplied
 * coordinate, opens a popup with the OpenCage formatted address, adds a
 * "📍 recenter" floating control, and a fullscreen toggle.  The page
 * notifies the host RN app via `window.ReactNativeWebView.postMessage`
 * so callers can react to map taps if they want.
 *
 * Pass `markerKind: "car"` for the live driver pin (white car silhouette
 * inside a brand-blue bubble), `"person"` for the booker / generic
 * "you are here" pin (white person inside the brand-blue bubble).
 */
export function liveLocationMapHtml(
  marker: Coords,
  opts: {
    zoom?: number;
    address?: string | null;
    markerKind?: "car" | "person";
    /** Hex colour for the marker bubble; defaults to brand blue. */
    accentColor?: string;
    /** Optional country flag emoji to show in the popup header. */
    flag?: string | null;
  } = {}
): string {
  const zoom = opts.zoom ?? 16;
  const accent = (opts.accentColor || "#1976D2").replace(/'/g, "");
  const kind = opts.markerKind ?? "person";
  // Inline SVG for the marker glyph — keeps the page self-contained so
  // it works offline once tiles are cached.
  const carSvg = `<svg viewBox='0 0 24 24' width='22' height='22' fill='#fff'><path d='M5 11l1.5-4.5C6.78 5.62 7.6 5 8.5 5h7c.9 0 1.72.62 2 1.5L19 11h.5a1.5 1.5 0 011.5 1.5V17a1 1 0 01-1 1h-1v.5a1.5 1.5 0 01-3 0V18H8v.5a1.5 1.5 0 01-3 0V18H4a1 1 0 01-1-1v-4.5A1.5 1.5 0 014.5 11H5zm1.7-1h10.6l-1-3a1 1 0 00-.95-.7H8.65a1 1 0 00-.95.7l-1 3zM6 14.5a1 1 0 100-2 1 1 0 000 2zm12 0a1 1 0 100-2 1 1 0 000 2z'/></svg>`;
  const personSvg = `<svg viewBox='0 0 24 24' width='22' height='22' fill='#fff'><path d='M12 12a4 4 0 100-8 4 4 0 000 8zm0 2c-3.31 0-8 1.66-8 5v1h16v-1c0-3.34-4.69-5-8-5z'/></svg>`;
  const glyph = kind === "car" ? carSvg : personSvg;

  const flagHeader = (opts.flag || "").trim();
  const address = (opts.address || "Your current location")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;");
  const lat = Number(marker.lat).toFixed(7);
  const lng = Number(marker.lng).toFixed(7);

  return `<!doctype html><html><head>
<meta name='viewport' content='initial-scale=1,maximum-scale=1,user-scalable=no'/>
<link rel='stylesheet' href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'/>
<style>
  html,body,#m{margin:0;padding:0;height:100%;width:100%;background:#f4f6f8}
  .mp{
    width:46px;height:46px;border-radius:23px;
    background:${accent};border:3px solid #fff;
    box-shadow:0 6px 16px rgba(0,0,0,.25);
    display:flex;align-items:center;justify-content:center;
    transform:translate(-23px,-23px);
  }
  .pulse{
    position:absolute;left:-23px;top:-23px;width:46px;height:46px;
    border-radius:23px;background:${accent};opacity:.35;
    animation:pulse 1.6s ease-out infinite;pointer-events:none;
  }
  @keyframes pulse{0%{transform:scale(.9);opacity:.45}100%{transform:scale(2.2);opacity:0}}
  .leaflet-popup-content{margin:10px 14px;font-family:-apple-system,Roboto,Segoe UI,sans-serif}
  .pop-title{font-size:13px;font-weight:700;color:#0A0A0A;margin:0 0 4px}
  .pop-sub{font-size:12px;color:#6B7176;line-height:1.45;margin:0}
  .pop-coord{margin-top:6px;font-size:11px;color:#6B7176;font-variant-numeric:tabular-nums}
  .ctl{
    position:absolute;right:12px;bottom:14px;z-index:1000;
    background:#fff;border:1px solid #E5E7EB;border-radius:999px;
    padding:8px 14px;font:600 12px -apple-system,Roboto,Segoe UI,sans-serif;
    color:#0A0A0A;box-shadow:0 4px 14px rgba(0,0,0,.18);cursor:pointer;
  }
</style>
</head><body>
<div id='m'></div>
<button id='rc' class='ctl'>📍 Recenter</button>
<script src='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'></script>
<script>
  const lat=${lat}, lng=${lng};
  const map = L.map('m', { zoomControl:true, attributionControl:true })
    .setView([lat, lng], ${zoom});
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
  const html = "<div class='pulse'></div><div class='mp'>${glyph}</div>";
  const icon = L.divIcon({ html: html, className: '', iconSize:[0,0], iconAnchor:[0,0] });
  const marker = L.marker([lat, lng], { icon: icon }).addTo(map);
  marker.bindPopup(
    "<div class='pop-title'>${flagHeader ? flagHeader + " " : ""}${address}</div>" +
    "<div class='pop-coord'>" + lat.toFixed(6) + ", " + lng.toFixed(6) + "</div>"
  ).openPopup();
  document.getElementById('rc').addEventListener('click', function(){
    map.flyTo([lat, lng], ${zoom});
    marker.openPopup();
  });
  function notify(msg){
    try{ window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(msg)); }catch(e){}
  }
  map.on('click', function(e){ notify({ type:'tap', lat:e.latlng.lat, lng:e.latlng.lng }); });
  map.whenReady(function(){ notify({ type:'ready' }); });
</script></body></html>`;
}
