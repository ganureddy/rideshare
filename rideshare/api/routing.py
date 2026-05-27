"""Open-source routing — OSRM proxy for road-snapped routes & ETAs.

Why a server-side proxy?
    * Hides the routing engine URL so we can switch from the public demo
      to a self-hosted instance (or to OpenRouteService / GraphHopper)
      without a mobile-app release.
    * Lets us cache results — a route between two points is stable for
      ~60s.  At our query volume the public OSRM demo would otherwise
      rate-limit us.
    * Adds a permission gate: only authenticated users may call.

No API key required.  In production set
``Rideshare Settings → OSRM Base URL`` to a self-hosted endpoint:

    docker run -p 5000:5000 -v $(pwd):/data osrm/osrm-backend \\
        osrm-routed --algorithm mld /data/india-latest.osrm

Then ``http://<host>:5000`` and you're done — no quotas, no key, no bills.
"""

from __future__ import annotations

import logging
from typing import Any

import frappe
import requests
from frappe import _

logger = logging.getLogger(__name__)

DEFAULT_OSRM = "https://router.project-osrm.org"
CACHE_NS = "rideshare:routing:v1"
# Round coordinates to ~11m of precision for the cache key — at city-scale
# the route doesn't change, but identical GPS fixes are very rare.
COORD_PRECISION = 4


def _osrm_base() -> str:
	return (
		frappe.db.get_single_value("Rideshare Settings", "osrm_base_url")
		or DEFAULT_OSRM
	).rstrip("/")


def _cache_ttl() -> int:
	return int(
		frappe.db.get_single_value("Rideshare Settings", "route_refresh_seconds") or 60
	)


def _cache_key(
	from_lat: float, from_lng: float, to_lat: float, to_lng: float
) -> str:
	a = f"{round(from_lat, COORD_PRECISION)},{round(from_lng, COORD_PRECISION)}"
	b = f"{round(to_lat, COORD_PRECISION)},{round(to_lng, COORD_PRECISION)}"
	return f"{a}|{b}"


def _coerce_latlng(name: str, lat: Any, lng: Any) -> tuple[float, float]:
	try:
		la = float(lat)
		ln = float(lng)
	except (TypeError, ValueError):
		frappe.throw(_("{0} must be numeric lat/lng.").format(name))
	if not (-90 <= la <= 90 and -180 <= ln <= 180):
		frappe.throw(_("{0} coordinates out of range.").format(name))
	return la, ln


@frappe.whitelist()
def route(
	from_lat: float,
	from_lng: float,
	to_lat: float,
	to_lng: float,
	profile: str = "driving",
) -> dict:
	"""Return a road-snapped route between two points.

	Response::

	    {
	      "ok": True,
	      "distance_km": 12.4,
	      "duration_minutes": 19,
	      "polyline": [[lat, lng], [lat, lng], ...],   # already lat,lng order
	      "eta_minutes": 19,
	      "engine": "osrm",
	      "cached": False
	    }

	On any upstream failure the helper still returns a usable response with
	``ok: False`` and a haversine straight-line distance, so the UI can
	always draw *something*.
	"""

	if frappe.session.user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	f_la, f_ln = _coerce_latlng("Origin", from_lat, from_lng)
	t_la, t_ln = _coerce_latlng("Destination", to_lat, to_lng)
	profile = profile if profile in ("driving", "cycling", "walking") else "driving"

	cache = frappe.cache()
	key = f"{profile}:{_cache_key(f_la, f_ln, t_la, t_ln)}"
	hit = cache.hget(CACHE_NS, key)
	if hit:
		hit["cached"] = True
		return hit

	url = (
		f"{_osrm_base()}/route/v1/{profile}/"
		f"{f_ln},{f_la};{t_ln},{t_la}"
		"?overview=full&geometries=geojson&steps=false&alternatives=false"
	)
	try:
		resp = requests.get(url, timeout=8, headers={"User-Agent": "Rideshare/1.0"})
		resp.raise_for_status()
		body = resp.json()
		if body.get("code") != "Ok" or not body.get("routes"):
			raise ValueError(body.get("message") or "no route")
		r = body["routes"][0]
		# OSRM returns [lng, lat]; we hand back [lat, lng] for react-native-maps.
		polyline = [[c[1], c[0]] for c in r["geometry"]["coordinates"]]
		out = {
			"ok": True,
			"distance_km": round(r["distance"] / 1000, 2),
			"duration_minutes": int(round(r["duration"] / 60)),
			"eta_minutes": int(round(r["duration"] / 60)),
			"polyline": polyline,
			"engine": "osrm",
			"cached": False,
		}
		cache.hset(CACHE_NS, key, out)
		cache.expire(CACHE_NS, _cache_ttl())
		return out
	except Exception as e:
		logger.warning("rideshare.routing.route OSRM failed: %s", e)
		# Fallback: straight-line haversine so the UI always has *something*.
		from rideshare.utils.geo import LatLng, estimate_duration_minutes, haversine_km

		distance_km = round(haversine_km(LatLng(f_la, f_ln), LatLng(t_la, t_ln)), 2)
		eta = estimate_duration_minutes(distance_km)
		return {
			"ok": False,
			"error": str(e),
			"distance_km": distance_km,
			"duration_minutes": eta,
			"eta_minutes": eta,
			"polyline": [[f_la, f_ln], [t_la, t_ln]],
			"engine": "haversine-fallback",
			"cached": False,
		}


@frappe.whitelist()
def route_to_ride(ride: str) -> dict:
	"""Convenience: route from the driver's *current* GPS fix to the ride's
	destination.  Used by the passenger app to show "driver is X minutes
	away" on the live-tracking screen.

	If the driver hasn't pushed a fix yet we fall back to the ride's
	``origin`` so the polyline shows the planned route.
	"""

	if frappe.session.user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	row = frappe.db.get_value(
		"Ride",
		ride,
		[
			"current_lat",
			"current_lng",
			"origin_lat",
			"origin_lng",
			"destination_lat",
			"destination_lng",
			"status",
		],
		as_dict=True,
	)
	if not row:
		frappe.throw(_("Ride not found."))

	if row.current_lat is not None and row.current_lng is not None:
		start_lat, start_lng = row.current_lat, row.current_lng
		used = "current"
	else:
		start_lat, start_lng = row.origin_lat, row.origin_lng
		used = "origin"

	out = route(start_lat, start_lng, row.destination_lat, row.destination_lng)
	out["start"] = {"lat": start_lat, "lng": start_lng, "source": used}
	out["destination"] = {"lat": row.destination_lat, "lng": row.destination_lng}
	out["ride_status"] = row.status
	return out


@frappe.whitelist()
def eta_to_pickup(ride: str, booking: str | None = None) -> dict:
	"""ETA from the driver's current position to the passenger's pickup.

	If ``booking`` is provided and has a pickup waypoint, route to that
	waypoint's coordinates; otherwise route to the ride's origin.
	"""

	if frappe.session.user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	row = frappe.db.get_value(
		"Ride",
		ride,
		["current_lat", "current_lng", "origin_lat", "origin_lng"],
		as_dict=True,
	)
	if not row:
		frappe.throw(_("Ride not found."))
	if row.current_lat is None:
		return {"ok": False, "error": "no_driver_location"}

	pickup_lat, pickup_lng = row.origin_lat, row.origin_lng
	if booking:
		waypoint = frappe.db.get_value(
			"Booking", booking, "pickup_waypoint"
		)
		if waypoint:
			wp = frappe.db.get_value(
				"Ride Waypoint", waypoint, ["lat", "lng"], as_dict=True
			)
			if wp and wp.lat and wp.lng:
				pickup_lat, pickup_lng = wp.lat, wp.lng

	return route(row.current_lat, row.current_lng, pickup_lat, pickup_lng)
