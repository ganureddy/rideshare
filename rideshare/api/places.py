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

import re
from typing import Any

import frappe
import requests
from frappe import _
from frappe.rate_limiter import rate_limit

GOOGLE_AC_URL = "https://maps.googleapis.com/maps/api/place/autocomplete/json"
GOOGLE_DETAILS_URL = "https://maps.googleapis.com/maps/api/place/details/json"
GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"
OPENCAGE_GEOCODE_URL = "https://api.opencagedata.com/geocode/v1/json"
DEFAULT_TIMEOUT = 6  # seconds — Google p95 is well under this

# `requests` exception messages embed the request URL, which for these
# providers always includes ?key=<API_KEY>.  Run every logged message
# through this redactor so we don't leak credentials into the Error Log
# DocType (which is readable by every System Manager).
_KEY_QS_RE = re.compile(r"([?&](?:key|api_key|access_token)=)[^&\s]+", re.IGNORECASE)


def _redact(text: str) -> str:
	if not text:
		return text
	return _KEY_QS_RE.sub(r"\1[REDACTED]", text)


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


def _opencage_key() -> str:
	key = frappe.utils.password.get_decrypted_password(
		"Rideshare Settings", "Rideshare Settings", "opencage_api_key", raise_exception=False
	)
	if not key:
		frappe.throw(
			_("OpenCage API key is not configured. Set it in Rideshare Settings."),
			frappe.ValidationError,
		)
	return key


def _provider() -> str:
	return frappe.db.get_single_value("Rideshare Settings", "maps_provider") or "OpenCage"


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

	provider = _provider()
	if provider == "OpenCage":
		return _opencage_autocomplete(q, country, lat, lng)
	if provider != "Google":
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
		frappe.log_error(message=_redact(str(exc)), title="Places autocomplete failed")
		frappe.throw(_("Map service unavailable. Please try again."))

	data = resp.json()
	if data.get("status") not in ("OK", "ZERO_RESULTS"):
		frappe.log_error(
			message=_redact(str(data)),
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

	provider = _provider()
	if provider == "OpenCage":
		# OpenCage is a single-call provider: the "place_id" is actually our
		# encoded "lat,lng" tuple from the autocomplete step.
		return _opencage_place_details(place_id)
	if provider != "Google":
		frappe.throw(_("place_details requires Google or OpenCage provider."))

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
		frappe.log_error(message=_redact(str(exc)), title="Places details failed")
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
	"""Resolve a coordinate pair into a postal address.

	Used by the "use my current location" button on the search/publish
	screens AND by the live-tracking screen to label the driver's last
	known position.  Provider-routed via Rideshare Settings.maps_provider.
	"""

	provider = _provider()
	if provider == "OpenCage":
		return _opencage_reverse_geocode(float(lat), float(lng))
	if provider != "Google":
		frappe.throw(_("reverse_geocode requires Google or OpenCage provider."))

	params = {
		"latlng": f"{float(lat)},{float(lng)}",
		"key": _api_key(),
	}
	try:
		resp = requests.get(GOOGLE_GEOCODE_URL, params=params, timeout=DEFAULT_TIMEOUT)
		resp.raise_for_status()
	except requests.RequestException as exc:
		frappe.log_error(message=_redact(str(exc)), title="Reverse geocode failed")
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


# ---------------------------------------------------------------------------
# OpenCage adapter — preferred for India-first deployments.  One endpoint
# does both forward and reverse geocoding; the API key never ships in the
# mobile bundle, mirroring the Google flow.
# ---------------------------------------------------------------------------


def _opencage_call(params: dict[str, Any]) -> list[dict]:
	full_params = {"key": _opencage_key(), "no_annotations": 1, "limit": 8, **params}
	try:
		resp = requests.get(OPENCAGE_GEOCODE_URL, params=full_params, timeout=DEFAULT_TIMEOUT)
		resp.raise_for_status()
	except requests.RequestException as exc:
		frappe.log_error(message=_redact(str(exc)), title="OpenCage call failed")
		frappe.throw(_("Map service unavailable. Please try again."))
	data = resp.json()
	if data.get("status", {}).get("code") not in (200, None):
		frappe.log_error(message=_redact(str(data)), title="OpenCage error")
		return []
	return data.get("results") or []


def _opencage_pred(r: dict) -> dict[str, Any]:
	"""Shape an OpenCage result like a Google Places prediction so the
	mobile app can consume both providers without branching."""

	g = r.get("geometry") or {}
	c = r.get("components") or {}
	lat = g.get("lat")
	lng = g.get("lng")
	primary = (
		c.get("road")
		or c.get("neighbourhood")
		or c.get("suburb")
		or c.get("village")
		or c.get("town")
		or c.get("city")
		or c.get("county")
		or c.get("state_district")
		or c.get("state")
		or r.get("formatted")
	)
	secondary_parts = [
		c.get("suburb") if primary != c.get("suburb") else None,
		c.get("city") if primary != c.get("city") else None,
		c.get("state_district") if primary != c.get("state_district") else None,
		c.get("state") if primary != c.get("state") else None,
		c.get("country") if c.get("country") and c.get("country") != "India" else None,
	]
	secondary = ", ".join([p for p in secondary_parts if p]) or r.get("formatted")
	return {
		# Encode the coordinate so place_details is a no-op round trip.
		"place_id": f"oc:{lat},{lng}" if lat is not None and lng is not None else r.get("formatted"),
		"description": r.get("formatted"),
		"primary_text": primary,
		"secondary_text": secondary,
		"types": [],
		"_oc": {"lat": lat, "lng": lng, "components": c},
	}


def _opencage_autocomplete(
	q: str, country: str, lat: float | None, lng: float | None
) -> dict[str, Any]:
	params: dict[str, Any] = {
		"q": q,
		"countrycode": (country or "in").lower(),
		"language": "en",
	}
	if lat is not None and lng is not None:
		params["proximity"] = f"{lat},{lng}"
	results = _opencage_call(params)
	return {"predictions": [_opencage_pred(r) for r in results]}


def _opencage_place_details(place_id: str) -> dict[str, Any]:
	"""``place_id`` here is "oc:lat,lng" emitted by ``_opencage_pred``.
	Fall back to a forward geocode if it's free-text."""

	if place_id.startswith("oc:"):
		try:
			lat_s, lng_s = place_id[3:].split(",")
			lat, lng = float(lat_s), float(lng_s)
		except (ValueError, AttributeError):
			frappe.throw(_("Invalid place reference."))
		return _opencage_reverse_geocode(lat, lng)
	results = _opencage_call({"q": place_id, "limit": 1})
	if not results:
		frappe.throw(_("Could not resolve that place."))
	r = results[0]
	g = r.get("geometry") or {}
	c = r.get("components") or {}
	return {
		"place_id": place_id,
		"name": c.get("city") or c.get("town") or c.get("village"),
		"address": r.get("formatted"),
		"lat": g.get("lat"),
		"lng": g.get("lng"),
		"city": c.get("city") or c.get("town") or c.get("village") or c.get("county"),
		"state": c.get("state"),
		"country": c.get("country"),
	}


def _opencage_reverse_geocode(lat: float, lng: float) -> dict[str, Any]:
	results = _opencage_call({"q": f"{lat}+{lng}", "limit": 1, "language": "en"})
	if not results:
		return {"address": None, "lat": lat, "lng": lng}
	r = results[0]
	c = r.get("components") or {}
	a = r.get("annotations") or {}
	# Surface the long form so callers (HTML map, dashboards, audit logs)
	# can render the OpenCage breakdown without re-querying.
	return {
		"address": r.get("formatted"),
		"formatted": r.get("formatted"),
		"place_id": f"oc:{lat},{lng}",
		"lat": lat,
		"lng": lng,
		"confidence": r.get("confidence"),
		"city": c.get("city")
		or c.get("town")
		or c.get("village")
		or c.get("county")
		or c.get("state_district"),
		"state": c.get("state"),
		"state_code": c.get("state_code"),
		"state_district": c.get("state_district"),
		"county": c.get("county"),
		"country": c.get("country"),
		"country_code": c.get("country_code"),
		"flag": a.get("flag"),
		"timezone": (a.get("timezone") or {}).get("name"),
		"postcode": c.get("postcode"),
		"suburb": c.get("suburb")
		or c.get("neighbourhood")
		or c.get("residential"),
		"road": c.get("road"),
		"road_type": c.get("road_type"),
		"category": c.get("_category") or r.get("_category"),
		"type": c.get("_type") or r.get("_type"),
		# Backwards-compatible alias used by other screens.
		"area": c.get("residential")
		or c.get("neighbourhood")
		or c.get("suburb")
		or c.get("road"),
	}


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
