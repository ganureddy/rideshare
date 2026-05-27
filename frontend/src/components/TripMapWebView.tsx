// Self-contained Leaflet + OpenStreetMap WebView.
//
// Why a WebView instead of `react-native-maps`?
// =============================================
// `react-native-maps` is a native module that has been crashing the
// Android process at MapView mount time on multiple devices the user
// has tested.  R8/ProGuard, coordinate validation, and try/catch
// wrappers all reduced the failure rate but never to zero.  The
// crash is silent (no JS error), so the app simply closes.
//
// Leaflet inside a WebView is bullet-proof on every Android phone we
// support: it's just HTML + JS rendered by the system WebView, no
// custom native code.  The same pattern is already proven in
// `MyLocationScreen` and `ChatThread` — neither has crashed.
//
// API surface
// -----------
// One declarative prop bag.  Re-rendering the component pushes new
// state into the WebView via `injectJavaScript("rsUpdate(...)")`,
// keeping the React layer stateless w.r.t. the map's internal Leaflet
// objects.  No per-tap socket setup; no native module lifecycle.
//
// Coordinates are filtered defensively before they reach the WebView
// — non-finite values would crash Leaflet's `L.latLng` just like they
// would crash native maps, just less catastrophically (the WebView
// shows a blank tile rather than killing the app).

import React, { useEffect, useMemo, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { validLatLng } from "@/utils/mapSafe";

export type LatLng = { lat: number; lng: number };

export type TripMapState = {
  origin?: LatLng | null;
  destination?: LatLng | null;
  /** Live driver fix; renders a car marker. */
  driver?:
    | (LatLng & {
        heading?: number | null;
        /** When true, shows a green pulsing halo (fresh fix). */
        fresh?: boolean;
      })
    | null;
  /** One pin per active passenger booking. */
  passengers?: Array<LatLng & { bookingId: string; isSelf?: boolean }>;
  /** Road-snapped route polyline (e.g. from OSRM). */
  route?: LatLng[];
  /** Optional A* approach polyline; rendered dashed teal. */
  aStar?: LatLng[];
};

const DEFAULT_CENTER: LatLng = { lat: 20.5937, lng: 78.9629 }; // India centroid

/**
 * Sanitise an incoming TripMapState so non-finite numbers can never
 * reach the WebView.  Leaflet doesn't crash on bad coords the way
 * react-native-maps does, but a NaN polyline silently disappears
 * and we'd rather log + skip cleanly.
 */
function sanitise(state: TripMapState | undefined): TripMapState {
  if (!state) return {};
  const cleanPt = <T extends LatLng>(p?: T | null): T | null =>
    p && validLatLng(p.lat, p.lng) ? p : null;
  const cleanList = <T extends LatLng>(arr?: T[]): T[] =>
    (arr || []).filter((p) => p && validLatLng(p.lat, p.lng));
  return {
    origin: cleanPt(state.origin),
    destination: cleanPt(state.destination),
    driver: cleanPt(state.driver) as TripMapState["driver"],
    passengers: cleanList(state.passengers || []),
    route: cleanList(state.route || []),
    aStar: cleanList(state.aStar || [])
  };
}

export function TripMapWebView({
  state,
  style
}: {
  state?: TripMapState;
  style?: object;
}) {
  const webRef = useRef<WebView | null>(null);
  const cleaned = useMemo(() => sanitise(state), [state]);
  const initial = useRef(cleaned);

  // Push new state into the running WebView.  Skip the very first
  // render — the page initialises itself with `initialState` baked
  // into the HTML, so the first updateState would be a no-op.
  const isFirst = useRef(true);
  useEffect(() => {
    if (isFirst.current) {
      isFirst.current = false;
      return;
    }
    const js = `try { window.rsUpdate(${JSON.stringify(cleaned)}); } catch (e) {} true;`;
    webRef.current?.injectJavaScript(js);
  }, [cleaned]);

  return (
    <View style={[s.container, style]}>
      <WebView
        ref={(r) => {
          webRef.current = r;
        }}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled
        // We don't share cookies — the page is fully static.
        sharedCookiesEnabled={false}
        // Don't let the WebView intercept system back nav.
        setBuiltInZoomControls={false}
        scalesPageToFit
        // The HTML is generated once with the *initial* state
        // baked in.  Subsequent updates flow through
        // `injectJavaScript`, which is much cheaper than
        // re-rendering the page.
        source={{ html: buildHtml(initial.current) }}
        style={{ backgroundColor: "#F2F6FA" }}
        // Block external navigations (e.g. Razorpay redirects we
        // accidentally embed).  Tile fetches still work because
        // those are XHR / image loads.
        onShouldStartLoadWithRequest={(req) => req.url.startsWith("about:")}
        // Ignore all WebView errors — the page is local HTML, the
        // only "errors" are tile fetch failures which Leaflet
        // handles internally.
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F2F6FA", overflow: "hidden" }
});

// ---------------------------------------------------------------------------
// HTML / JS for the Leaflet map.  Kept inline so the component is
// self-contained — drop in anywhere, no asset config required.
// ---------------------------------------------------------------------------

function buildHtml(initialState: TripMapState): string {
  const initialJson = JSON.stringify(initialState).replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    html, body, #m { margin: 0; padding: 0; height: 100%; width: 100%; background: #F2F6FA; }
    .pin {
      width: 28px; height: 28px; border-radius: 14px;
      background: #0A0A0A; color: #fff;
      display: flex; align-items: center; justify-content: center;
      border: 3px solid #fff;
      box-shadow: 0 2px 6px rgba(0,0,0,.25);
      font-size: 14px; font-weight: 700;
    }
    .pin.driver { background: #0A0A0A; width: 38px; height: 38px; border-radius: 19px; }
    .pin.driver .halo {
      position: absolute; width: 60px; height: 60px; border-radius: 30px;
      background: rgba(31, 138, 76, 0.4);
      animation: rs-pulse 1.6s ease-out infinite;
    }
    @keyframes rs-pulse {
      0%   { transform: scale(0.4); opacity: 0.7; }
      100% { transform: scale(1.7); opacity: 0; }
    }
    .pin.passenger { background: #1976D2; }
    .pin.pickup    { background: #1F8A4C; width: 22px; height: 22px; }
    .pin.drop      { background: #D32F2F; width: 22px; height: 22px; border-radius: 4px; }
    .pin.self      { background: #1976D2; outline: 2px solid #fff; outline-offset: -4px; }
    .leaflet-control-attribution { font-size: 9px; }
  </style>
</head>
<body>
  <div id="m"></div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    (function () {
      // Defensive: Leaflet sometimes fails to load on flaky networks.
      // Render a graceful blank background until it's ready.
      if (typeof L === "undefined") {
        document.body.style.background = "#F2F6FA";
        return;
      }

      var INITIAL_STATE = ${initialJson};
      var DEFAULT = { lat: ${DEFAULT_CENTER.lat}, lng: ${DEFAULT_CENTER.lng} };

      function isValid(p) {
        return p
          && typeof p.lat === "number" && isFinite(p.lat)
          && typeof p.lng === "number" && isFinite(p.lng);
      }

      function pickCentre(state) {
        // Priority: driver fix → first passenger → origin → destination → India.
        if (isValid(state.driver))             return [state.driver.lat, state.driver.lng];
        if (state.passengers && state.passengers.length && isValid(state.passengers[0]))
                                                return [state.passengers[0].lat, state.passengers[0].lng];
        if (isValid(state.origin))             return [state.origin.lat, state.origin.lng];
        if (isValid(state.destination))        return [state.destination.lat, state.destination.lng];
        return [DEFAULT.lat, DEFAULT.lng];
      }

      var map = L.map("m", {
        center: pickCentre(INITIAL_STATE),
        zoom: 13,
        zoomControl: true,
        attributionControl: true
      });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OSM"
      }).addTo(map);

      // Layer handles — one per concept.  Mutated in place by rsUpdate
      // so we never re-create Leaflet objects (cheaper, smoother).
      var pickupMarker = null;
      var dropMarker = null;
      var driverMarker = null;
      var passengerMarkers = {}; // bookingId → marker
      var routeLine = null;
      var aStarLine = null;

      function divIcon(html, w, h) {
        return L.divIcon({
          className: "",
          html: html,
          iconSize: [w, h],
          iconAnchor: [w / 2, h / 2]
        });
      }

      function setOrCreateMarker(existing, latlng, html, w, h, title) {
        if (!existing) {
          existing = L.marker(latlng, { icon: divIcon(html, w, h), title: title || "" }).addTo(map);
        } else {
          existing.setLatLng(latlng);
          existing.setIcon(divIcon(html, w, h));
        }
        return existing;
      }

      function rsUpdate(state) {
        if (!state || typeof state !== "object") return;

        // -- pickup
        if (isValid(state.origin)) {
          pickupMarker = setOrCreateMarker(
            pickupMarker,
            [state.origin.lat, state.origin.lng],
            '<div class="pin pickup" title="Pickup"></div>', 22, 22, "Pickup"
          );
        } else if (pickupMarker) {
          map.removeLayer(pickupMarker);
          pickupMarker = null;
        }

        // -- destination
        if (isValid(state.destination)) {
          dropMarker = setOrCreateMarker(
            dropMarker,
            [state.destination.lat, state.destination.lng],
            '<div class="pin drop" title="Destination"></div>', 22, 22, "Destination"
          );
        } else if (dropMarker) {
          map.removeLayer(dropMarker);
          dropMarker = null;
        }

        // -- route polyline (OSRM road-snapped)
        if (state.route && state.route.length >= 2) {
          var coords = state.route.filter(isValid).map(function (p) { return [p.lat, p.lng]; });
          if (!routeLine) {
            routeLine = L.polyline(coords, { color: "#0A0A0A", weight: 4, opacity: 0.9 }).addTo(map);
          } else {
            routeLine.setLatLngs(coords);
          }
        } else if (routeLine) {
          map.removeLayer(routeLine);
          routeLine = null;
        }

        // -- A* approach polyline (teal dashed)
        if (state.aStar && state.aStar.length >= 2) {
          var aCoords = state.aStar.filter(isValid).map(function (p) { return [p.lat, p.lng]; });
          if (!aStarLine) {
            aStarLine = L.polyline(aCoords, {
              color: "#0EA5A4", weight: 3, opacity: 0.85, dashArray: "10 6"
            }).addTo(map);
          } else {
            aStarLine.setLatLngs(aCoords);
          }
        } else if (aStarLine) {
          map.removeLayer(aStarLine);
          aStarLine = null;
        }

        // -- driver pin (with optional pulse halo)
        if (isValid(state.driver)) {
          var carHtml = '<div class="pin driver" title="Driver"><span style="position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:100%;">'
            + (state.driver.fresh !== false ? '<span class="halo"></span>' : '')
            + '🚗</span></div>';
          driverMarker = setOrCreateMarker(
            driverMarker, [state.driver.lat, state.driver.lng],
            carHtml, 38, 38, "Driver"
          );
        } else if (driverMarker) {
          map.removeLayer(driverMarker);
          driverMarker = null;
        }

        // -- passenger pins (keyed on bookingId so adds/removes are cheap)
        var present = {};
        var passengers = (state.passengers || []).filter(isValid);
        for (var i = 0; i < passengers.length; i++) {
          var p = passengers[i];
          present[p.bookingId] = true;
          var html = '<div class="pin passenger ' + (p.isSelf ? "self" : "") + '" title="Passenger">👤</div>';
          passengerMarkers[p.bookingId] = setOrCreateMarker(
            passengerMarkers[p.bookingId],
            [p.lat, p.lng], html, 28, 28, "Passenger"
          );
        }
        for (var bookingId in passengerMarkers) {
          if (!present[bookingId] && passengerMarkers[bookingId]) {
            map.removeLayer(passengerMarkers[bookingId]);
            delete passengerMarkers[bookingId];
          }
        }

        // -- recentre on the active focus (driver if present, else
        // origin) when it's appreciably different from the current
        // map centre.  Keeps the camera following without snapping
        // on every tiny GPS jitter.
        var focus = isValid(state.driver)
          ? [state.driver.lat, state.driver.lng]
          : isValid(state.origin)
            ? [state.origin.lat, state.origin.lng]
            : null;
        if (focus) {
          var c = map.getCenter();
          var dlat = Math.abs(c.lat - focus[0]);
          var dlng = Math.abs(c.lng - focus[1]);
          if (dlat > 0.0008 || dlng > 0.0008) {
            map.panTo(focus, { animate: true, duration: 0.6 });
          }
        }
      }

      window.rsUpdate = rsUpdate;
      // Initial paint after layout settles — Leaflet sometimes mounts
      // with the wrong tile origin if the viewport size isn't ready.
      setTimeout(function () { try { map.invalidateSize(true); } catch (e) {} }, 100);
      rsUpdate(INITIAL_STATE);

      // Tell the host we're ready, just in case it wants to know.
      try {
        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: "ready" }));
        }
      } catch (e) {}
    })();
  </script>
</body>
</html>`;
}
