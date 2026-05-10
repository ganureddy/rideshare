"""Google Places autocomplete proxy.

The mobile app sends every keystroke through these endpoints rather than
calling Google directly.  Two reasons:

1. The API key never ships in the APK (it stays server-side, in
   ``Rideshare Settings.google_maps_api_key``).
2. We can swap providers (Mapbox, OSM Nominatim) by editing only the
   ``maps_provider`` field — clients keep the same endpoint contract.

Endpoints are ``allow_guest=True`` so the search bar on the public web
search and the login-screen-adjacent flows work before the user signs in.
A daily ratelimit is applied per IP to keep the bill bounded.
"""

from __future__ import annotations

from typing import Any

import frappe
import requests
from frappe import _
from frappe.rate_limiter import rate_limit

GOOGLE_AC_URL = "https://maps.googleapis.com/maps/api/place/autocomplete/json"
GOOGLE_DETAILS_URL = "https://maps.googleapis.com/maps/api/place/details/json"
GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"
DEFAULT_TIMEOUT = 6  # seconds — Google p95 is well under this


def _api_key() -> str:
	key = frappe.utils.password.get_decrypted_password(
		"Rideshare Settings", "Rideshare Settings", "google_maps_api_key", raise_exception=False
	)
	if not key:
		frappe.throw(
			_("Google Maps API key is not configured. Set it in Rideshare Settings."),
			frappe.ValidationError,
		)
	return key


def _provider() -> str:
	return frappe.db.get_single_value("Rideshare Settings", "maps_provider") or "Google"


@frappe.whitelist(allow_guest=True)
@rate_limit(limit=120, seconds=60)
def autocomplete(
	query: str,
	session_token: str | None = None,
	country: str = "in",
	lat: float | None = None,
	lng: float | None = None,
	radius_m: int = 50000,
) -> dict[str, Any]:
	"""Return place autocomplete predictions for ``query``.

	The optional ``lat``/``lng``/``radius_m`` triple biases results toward
	the user's current location — pass them for far better local matching.
	``session_token`` should be a stable, opaque string for the duration of
	a single autocomplete-then-details flow (Google bills the session as
	one autocomplete request when paired correctly).
	"""

	q = (query or "").strip()
	if len(q) < 2:
		return {"predictions": []}

	if _provider() != "Google":
		# OSM/Mapbox fallback path — implement when we flip the flag.
		return _osm_autocomplete(q, country, lat, lng)

	params: dict[str, Any] = {
		"input": q,
		"key": _api_key(),
		"components": f"country:{country}",
		"language": "en",
	}
	if session_token:
		params["sessiontoken"] = session_token
	if lat is not None and lng is not None:
		params["location"] = f"{lat},{lng}"
		params["radius"] = int(radius_m)
		params["strictbounds"] = "false"

	try:
		resp = requests.get(GOOGLE_AC_URL, params=params, timeout=DEFAULT_TIMEOUT)
		resp.raise_for_status()
	except requests.RequestException as exc:
		frappe.log_error(message=str(exc), title="Places autocomplete failed")
		frappe.throw(_("Map service unavailable. Please try again."))

	data = resp.json()
	if data.get("status") not in ("OK", "ZERO_RESULTS"):
		frappe.log_error(
			message=str(data),
			title=f"Google Places error: {data.get('status')}",
		)
		return {"predictions": []}

	preds = []
	for p in data.get("predictions", []):
		preds.append(
			{
				"place_id": p.get("place_id"),
				"description": p.get("description"),
				"primary_text": (p.get("structured_formatting") or {}).get("main_text"),
				"secondary_text": (p.get("structured_formatting") or {}).get("secondary_text"),
				"types": p.get("types", []),
			}
		)
	return {"predictions": preds}


@frappe.whitelist(allow_guest=True)
@rate_limit(limit=120, seconds=60)
def place_details(place_id: str, session_token: str | None = None) -> dict[str, Any]:
	"""Resolve a Google ``place_id`` into lat/lng + a clean address."""

	if not place_id:
		frappe.throw(_("place_id is required."), frappe.ValidationError)

	if _provider() != "Google":
		frappe.throw(_("place_details requires Google provider."))

	params: dict[str, Any] = {
		"place_id": place_id,
		"key": _api_key(),
		"fields": "place_id,name,formatted_address,geometry/location,address_components",
	}
	if session_token:
		params["sessiontoken"] = session_token

	try:
		resp = requests.get(GOOGLE_DETAILS_URL, params=params, timeout=DEFAULT_TIMEOUT)
		resp.raise_for_status()
	except requests.RequestException as exc:
		frappe.log_error(message=str(exc), title="Places details failed")
		frappe.throw(_("Map service unavailable."))

	data = resp.json()
	if data.get("status") != "OK":
		frappe.throw(_("Could not resolve that place."))
	r = data.get("result", {})
	loc = ((r.get("geometry") or {}).get("location")) or {}
	return {
		"place_id": r.get("place_id"),
		"name": r.get("name"),
		"address": r.get("formatted_address"),
		"lat": loc.get("lat"),
		"lng": loc.get("lng"),
		"city": _extract_component(r, "locality") or _extract_component(r, "administrative_area_level_2"),
		"state": _extract_component(r, "administrative_area_level_1"),
		"country": _extract_component(r, "country"),
	}


@frappe.whitelist(allow_guest=True)
@rate_limit(limit=60, seconds=60)
def reverse_geocode(lat: float, lng: float) -> dict[str, Any]:
	"""Resolve a coordinate pair into a postal address (used by the
	'use my current location' button)."""

	if _provider() != "Google":
		frappe.throw(_("reverse_geocode requires Google provider."))

	params = {
		"latlng": f"{float(lat)},{float(lng)}",
		"key": _api_key(),
	}
	try:
		resp = requests.get(GOOGLE_GEOCODE_URL, params=params, timeout=DEFAULT_TIMEOUT)
		resp.raise_for_status()
	except requests.RequestException as exc:
		frappe.log_error(message=str(exc), title="Reverse geocode failed")
		frappe.throw(_("Map service unavailable."))

	data = resp.json()
	results = data.get("results") or []
	if not results:
		return {"address": None, "lat": lat, "lng": lng}
	r = results[0]
	return {
		"address": r.get("formatted_address"),
		"place_id": r.get("place_id"),
		"lat": float(lat),
		"lng": float(lng),
		"city": _extract_component(r, "locality") or _extract_component(r, "administrative_area_level_2"),
		"state": _extract_component(r, "administrative_area_level_1"),
		"country": _extract_component(r, "country"),
	}


def _extract_component(result: dict, type_name: str) -> str | None:
	for comp in result.get("address_components", []) or []:
		if type_name in (comp.get("types") or []):
			return comp.get("long_name")
	return None


def _osm_autocomplete(
	q: str, country: str, lat: float | None, lng: float | None
) -> dict[str, Any]:
	"""Nominatim fallback. Lower quality but free; useful in dev or as a
	disaster-recovery toggle when the Google account is rate-limited."""

	params = {
		"q": q,
		"format": "jsonv2",
		"addressdetails": 1,
		"limit": 8,
		"countrycodes": country,
	}
	headers = {"User-Agent": "rideshare-app/1.0"}
	try:
		resp = requests.get(
			"https://nominatim.openstreetmap.org/search",
			params=params, headers=headers, timeout=DEFAULT_TIMEOUT,
		)
		resp.raise_for_status()
	except requests.RequestException:
		return {"predictions": []}
	preds = []
	for r in resp.json():
		preds.append(
			{
				"place_id": str(r.get("place_id")),
				"description": r.get("display_name"),
				"primary_text": r.get("name") or r.get("display_name"),
				"secondary_text": r.get("display_name"),
				"types": [r.get("type")],
				"_osm": {"lat": float(r["lat"]), "lng": float(r["lon"])},
			}
		)
	return {"predictions": preds}
