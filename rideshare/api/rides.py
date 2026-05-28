"""Driver-facing endpoints: publish a ride, manage own rides, suggest price."""

from __future__ import annotations

import json
import re
from difflib import SequenceMatcher
from typing import Any

import frappe
from frappe import _

from rideshare.utils.geo import LatLng, estimate_duration_minutes, haversine_km


@frappe.whitelist(allow_guest=True)
def suggest_price(
	origin_lat: float,
	origin_lng: float,
	destination_lat: float,
	destination_lng: float,
) -> dict:
	"""Return distance, duration and a fair-price band for a trip."""

	a = LatLng(float(origin_lat), float(origin_lng))
	b = LatLng(float(destination_lat), float(destination_lng))
	distance_km = haversine_km(a, b)
	duration_minutes = estimate_duration_minutes(distance_km)

	min_per_km = float(
		frappe.db.get_single_value("Rideshare Settings", "min_ride_price_per_km") or 2
	)
	max_per_km = float(
		frappe.db.get_single_value("Rideshare Settings", "max_ride_price_per_km") or 10
	)
	# Suggestion is per-passenger-seat, not total fuel cost.  The raw
	# distance-rate range from Rideshare Settings models the *trip's*
	# economic value; what we want to show in Publish is what a single
	# rider would chip in (BlaBlaCar-style "share the cost").  Halving
	# the band keeps the per-km settings untouched (used by ops + the
	# Desk views) while giving drivers a sensible default that doesn't
	# scare riders away.
	min_price = round(distance_km * min_per_km / 2)
	max_price = round(distance_km * max_per_km / 2)
	suggested = round(distance_km * (min_per_km + max_per_km) / 4)
	return {
		"distance_km": round(distance_km, 1),
		"duration_minutes": duration_minutes,
		"min_price": int(min_price),
		"max_price": int(max_price),
		"suggested_price": int(suggested),
	}


@frappe.whitelist()
def list_cities(query: str | None = None, limit: int = 50) -> list[dict]:
	"""Return active City records, optionally filtered by ``query``.

	Fuzzy search — three layers:
	  1. Cheap SQL pre-filter: any-word substring or first-letter match on
	     city_name / state / country, so we pull at most a few hundred rows.
	  2. Python-side relevance score: exact / prefix / contains / fuzzy
	     similarity (difflib SequenceMatcher) — recovers from typos like
	     "bnaglore" → "Bangalore" or "delih" → "Delhi".
	  3. Pad with the next alphabetical cities if nothing matched, so the
	     picker is never empty even on an unusual query.

	When no query is supplied we return the alphabetically-first ``limit``
	cities for instant suggestions.
	"""

	q = (query or "").strip()
	limit = int(limit or 50)

	if not q:
		return frappe.db.sql(
			"""SELECT name AS id, city_name AS label, state, country,
			          lat, lng, slug
			   FROM `tabCity`
			   WHERE is_active = 1
			   ORDER BY city_name ASC
			   LIMIT %(limit)s""",
			{"limit": limit},
			as_dict=True,
		)

	# 1. Cheap SQL pre-filter: any word matches anywhere, OR same starting
	#    letter as the query (catches typos like "bnaglore" → starts with "b"
	#    in our reference list of "bangalore").
	words = [w for w in re.split(r"\s+", q) if w]
	conds: list[str] = []
	values: dict[str, Any] = {"first": f"{q[0]}%"}
	for i, w in enumerate(words):
		key = f"w{i}"
		values[key] = f"%{w}%"
		conds.append(
			f"(city_name LIKE %({key})s OR state LIKE %({key})s OR country LIKE %({key})s)"
		)
	# Combine with OR so a single typo'd word still pulls candidates (the
	# Python ranker filters precisely below).
	candidate_clause = " OR ".join(conds) if conds else "1=1"
	# Always include first-letter-of-query matches as fuzzy fallback.
	sql = f"""
		SELECT name AS id, city_name AS label, state, country, lat, lng, slug
		FROM `tabCity`
		WHERE is_active = 1
		  AND ((LOWER(city_name) LIKE LOWER(%(first)s)) OR ({candidate_clause}))
		ORDER BY city_name ASC
		LIMIT 500
	"""
	candidates = frappe.db.sql(sql, values, as_dict=True)

	# 2. Score every candidate.
	q_lower = q.lower()
	scored: list[tuple[float, dict]] = []
	for c in candidates:
		score = _city_score(q_lower, c)
		if score > 0:
			scored.append((score, c))
	scored.sort(key=lambda t: (-t[0], t[1].get("label") or ""))
	results = [c for _s, c in scored[:limit]]

	# 3. Pad if too few matched — surface alphabetically-near cities so the
	#    user always sees something.
	if len(results) < min(8, limit):
		seen_ids = {r["id"] for r in results}
		extra = frappe.db.sql(
			"""SELECT name AS id, city_name AS label, state, country, lat, lng, slug
			   FROM `tabCity`
			   WHERE is_active = 1 AND city_name LIKE %(p)s
			   ORDER BY city_name ASC LIMIT 10""",
			{"p": f"{q[0]}%"},
			as_dict=True,
		)
		for c in extra:
			if c["id"] in seen_ids:
				continue
			results.append(c)
			if len(results) >= limit:
				break
	return results


def _city_score(q_lower: str, city: dict) -> float:
	"""Relevance for one candidate.  Higher = better.

	100 — exact city name match
	 90 — city name starts with the query
	 70 — city name contains every word of the query
	 50 — fuzzy similarity ratio >= 0.78 (handles typos)
	 35 — state / country contains the query
	 25 — fuzzy similarity ratio >= 0.6
	"""

	name = (city.get("label") or "").lower()
	state = (city.get("state") or "").lower()
	country = (city.get("country") or "").lower()

	if name == q_lower:
		return 100.0
	if name.startswith(q_lower):
		return 90.0

	# Every word matches as substring → strong contains.
	words = [w for w in re.split(r"\s+", q_lower) if w]
	if words and all(w in name for w in words):
		return 70.0

	# Fuzzy match on the city name (tolerates a typo or two).
	ratio = SequenceMatcher(None, q_lower, name).ratio()
	if ratio >= 0.78:
		return 50.0 + (ratio - 0.78) * 50  # 50 → ~61 as ratio approaches 1

	if q_lower in state or q_lower in country:
		return 35.0

	# Loose fuzzy fallback.
	if ratio >= 0.6:
		return 25.0 + (ratio - 0.6) * 25
	return 0.0


@frappe.whitelist(allow_guest=True)
def list_cities_public(query: str | None = None, limit: int = 50) -> list[dict]:
	"""Public version used by the homepage search box and the mobile app's
	city picker.  Same semantics as :func:`list_cities`."""

	return list_cities(query=query, limit=limit)


def _ensure_city(name: str | None, lat: float | None = None, lng: float | None = None) -> str | None:
	"""Find-or-create a City record for ``name``.

	Google Places returns free-text city names ("New Delhi", "Goa", "Old
	Mumbai") that may not exist as City records.  Rather than failing the
	publish step we materialise the row on-demand and reuse it next time.
	"""

	if not name:
		return None
	# City.autoname is the city_name field, so docname == city_name.  The
	# field is `unique=1`, which means an exact-match lookup is correct.
	clean = re.sub(r"\s+", " ", name).strip()
	if not clean:
		return None
	if frappe.db.exists("City", clean):
		# Backfill missing coordinates if the caller supplied them.
		if lat and lng:
			existing_lat, existing_lng = (
				frappe.db.get_value("City", clean, ["lat", "lng"]) or (0, 0)
			)
			if not (existing_lat and existing_lng):
				frappe.db.set_value("City", clean, {"lat": lat, "lng": lng})
		return clean
	doc = frappe.new_doc("City")
	doc.city_name = clean
	doc.country = "India"
	if lat and lng:
		doc.lat = lat
		doc.lng = lng
	doc.is_active = 1
	doc.flags.ignore_permissions = True
	doc.insert(ignore_permissions=True)
	return doc.name


@frappe.whitelist()
def publish_ride(payload: str | dict) -> dict:
	"""Create a Ride from the publish-wizard payload and mark Published.

	``payload`` is a JSON string (or dict) with the same shape as the
	wizard form (see ``/publish``).  Free-text origin/destination cities
	are upserted into the City table so the Link field validates.

	The wizard also passes nested ``vehicle``, ``driver`` and ``preferences``
	blocks the first time the user publishes a ride; we materialise them
	into the Vehicle and Driver Profile rows so that subsequent rides reuse
	the same details (and bookers see them on the ride detail screen).
	"""

	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	data = json.loads(payload) if isinstance(payload, str) else dict(payload)

	driver_block = data.get("driver") or {}
	preferences_block = data.get("preferences") or {}
	vehicle_block = data.get("vehicle_details") or {}

	_upsert_driver_profile_inline(user, driver_block, preferences_block)

	# Driver portrait — written straight to User.user_image so every place
	# that already renders the driver's avatar (chat, ride detail, search
	# cards) picks it up automatically.
	driver_photo = (driver_block.get("photo") or "").strip()
	if driver_photo:
		try:
			user_doc = frappe.get_doc("User", user)
			user_doc.user_image = driver_photo
			user_doc.flags.ignore_permissions = True
			user_doc.save(ignore_permissions=True)
		except Exception:
			frappe.log_error(
				title="Could not save driver portrait", message=frappe.get_traceback()
			)

	# Vehicle: prefer the explicit existing one, then upsert the wizard
	# block, then fall back to the user's first existing vehicle.
	vehicle = data.get("vehicle")
	if vehicle_block and (vehicle_block.get("make") or vehicle_block.get("model")):
		vehicle = _upsert_vehicle_inline(user, vehicle_block, existing=vehicle)
	if not vehicle:
		vehicle = frappe.db.get_value(
			"Vehicle", {"owner_user": user}, "name", order_by="creation asc"
		)
	if not vehicle:
		frappe.throw(_("Add a vehicle before publishing a ride."), frappe.ValidationError)

	# Materialise origin / destination Cities if needed.
	origin_city = _ensure_city(
		data.get("origin_city"),
		lat=_safe_float(data.get("origin_lat")),
		lng=_safe_float(data.get("origin_lng")),
	)
	destination_city = _ensure_city(
		data.get("destination_city"),
		lat=_safe_float(data.get("destination_lat")),
		lng=_safe_float(data.get("destination_lng")),
	)
	if not origin_city or not destination_city:
		frappe.throw(_("Origin and destination are required."), frappe.ValidationError)

	doc = frappe.new_doc("Ride")
	doc.driver = user
	doc.vehicle = vehicle
	doc.origin_city = origin_city
	doc.origin_address = data.get("origin_address")
	doc.origin_lat = _safe_float(data.get("origin_lat"))
	doc.origin_lng = _safe_float(data.get("origin_lng"))
	doc.destination_city = destination_city
	doc.destination_address = data.get("destination_address")
	doc.destination_lat = _safe_float(data.get("destination_lat"))
	doc.destination_lng = _safe_float(data.get("destination_lng"))
	doc.departure_datetime = data.get("departure_datetime")
	doc.seats_total = max(1, min(12, int(data.get("seats_total") or 3)))
	doc.price_per_seat = float(data.get("price_per_seat") or 0)
	doc.instant_booking = int(bool(data.get("instant_booking")))
	doc.women_only = int(bool(data.get("women_only")))
	doc.max_2_back = int(bool(data.get("max_2_back", 1)))
	doc.description = data.get("description")
	doc.cancellation_policy = data.get("cancellation_policy") or "Moderate"

	for idx, w in enumerate(data.get("waypoints") or [], start=1):
		w_city = _ensure_city(w.get("city"), lat=_safe_float(w.get("lat")), lng=_safe_float(w.get("lng")))
		if not w_city:
			continue
		doc.append(
			"waypoints",
			{
				"sequence": idx,
				"city": w_city,
				"lat": _safe_float(w.get("lat")),
				"lng": _safe_float(w.get("lng")),
				"pickup_offset_minutes": int(w.get("pickup_offset_minutes") or 0),
			},
		)

	doc.status = "Published"
	doc.flags.ignore_permissions = True
	doc.insert(ignore_permissions=True)
	frappe.db.commit()

	return {"name": doc.name, "status": doc.status}


def _safe_float(v) -> float | None:
	if v is None or v == "":
		return None
	try:
		return float(v)
	except (TypeError, ValueError):
		return None


def _safe_int(v, default: int | None = None) -> int | None:
	if v is None or v == "":
		return default
	try:
		return int(v)
	except (TypeError, ValueError):
		return default


_MUSIC_OPTIONS = {"Quiet", "Some", "Loud"}
_CHAT_OPTIONS = {"Quiet", "Some", "Chatty"}


def _upsert_driver_profile_inline(
	user: str, driver: dict, prefs: dict
) -> str:
	"""Create or update the caller's Driver Profile from publish-wizard data.

	Only fields the wizard supplied are touched; missing values keep their
	current values, so re-publishing doesn't wipe a previously-saved bio.
	"""

	existing = frappe.db.get_value("Driver Profile", {"user": user}, "name")
	if existing:
		profile = frappe.get_doc("Driver Profile", existing)
	else:
		profile = frappe.new_doc("Driver Profile")
		profile.user = user

	full_name = (driver.get("full_name") or "").strip()
	if full_name:
		profile.full_name = full_name
		# Mirror onto the User record so chat/contact surfaces show it too.
		try:
			user_doc = frappe.get_doc("User", user)
			parts = full_name.split()
			user_doc.first_name = parts[0]
			user_doc.last_name = " ".join(parts[1:]) if len(parts) > 1 else ""
			user_doc.full_name = full_name
			user_doc.flags.ignore_permissions = True
			user_doc.save(ignore_permissions=True)
		except Exception:
			pass

	if "bio" in driver:
		profile.bio = (driver.get("bio") or "").strip() or None
	if driver.get("license_number"):
		profile.license_number = driver["license_number"]
	if driver.get("license_expiry"):
		profile.license_expiry = driver["license_expiry"]

	# Preferences — apply the requested defaults when the user didn't pick.
	music = (prefs.get("music") or "").strip() or "Some"
	chat = (prefs.get("chat") or "").strip() or "Some"
	if music not in _MUSIC_OPTIONS:
		music = "Some"
	if chat not in _CHAT_OPTIONS:
		chat = "Some"
	profile.preferences_music = music
	profile.preferences_chat = chat
	profile.preferences_smoking = 1 if prefs.get("smoking") else 0
	profile.preferences_pets = 1 if prefs.get("pets") else 0

	profile.flags.ignore_permissions = True
	if existing:
		profile.save(ignore_permissions=True)
	else:
		profile.insert(ignore_permissions=True)
	return profile.name


def _upsert_vehicle_inline(user: str, vehicle: dict, existing: str | None) -> str:
	"""Create or update the caller's Vehicle from publish-wizard data."""

	if existing:
		doc = frappe.get_doc("Vehicle", existing)
		if doc.owner_user != user:
			frappe.throw(_("Not your vehicle."), frappe.PermissionError)
	else:
		# Reuse the user's first vehicle if any so we don't create duplicates
		# every time the wizard re-saves the same car.
		owned = frappe.db.get_value(
			"Vehicle", {"owner_user": user}, "name", order_by="creation asc"
		)
		if owned:
			doc = frappe.get_doc("Vehicle", owned)
		else:
			doc = frappe.new_doc("Vehicle")
			doc.owner_user = user

	if vehicle.get("make"):
		doc.make = vehicle["make"]
	if vehicle.get("model"):
		doc.model = vehicle["model"]
	year = _safe_int(vehicle.get("year"))
	if year:
		doc.year = year
	if "color" in vehicle:
		doc.color = (vehicle.get("color") or "").strip() or None
	seats = _safe_int(vehicle.get("seats_available"))
	if seats:
		doc.seats_available = max(1, min(12, seats))
	if vehicle.get("license_plate"):
		doc.license_plate = vehicle["license_plate"]

	# Photo gallery — keep the existing rows when the wizard didn't send a
	# fresh list (e.g. user re-published with the same car) and replace
	# them entirely otherwise.  Each entry is a file URL produced by the
	# /api/method/upload_file call from the mobile app.
	photos = vehicle.get("photos")
	if isinstance(photos, list):
		# Wipe existing rows and rebuild — keeps captions in sync.
		doc.set("photos", [])
		for idx, p in enumerate(photos):
			if isinstance(p, str) and p.strip():
				url = p.strip()
				caption = None
			elif isinstance(p, dict) and (p.get("photo") or "").strip():
				url = p["photo"].strip()
				caption = (p.get("caption") or None)
			else:
				continue
			doc.append(
				"photos",
				{"photo": url, "caption": caption or f"Photo {idx + 1}"},
			)

	doc.flags.ignore_permissions = True
	if doc.is_new():
		doc.insert(ignore_permissions=True)
	else:
		doc.save(ignore_permissions=True)
	return doc.name


@frappe.whitelist()
def my_rides(status: str | None = None) -> list[dict]:
	user = frappe.session.user
	if user == "Guest":
		return []
	filters: dict = {"driver": user}
	if status:
		filters["status"] = status
	return frappe.get_all(
		"Ride",
		filters=filters,
		fields=[
			"name",
			"origin_city",
			"destination_city",
			"departure_datetime",
			"seats_total",
			"seats_available",
			"price_per_seat",
			"status",
			"distance_km",
		],
		order_by="departure_datetime desc",
		limit_page_length=50,
	)


@frappe.whitelist()
def cancel_ride(ride: str, reason: str | None = None) -> dict:
	user = frappe.session.user
	doc = frappe.get_doc("Ride", ride)
	if doc.driver != user:
		frappe.throw(_("Not your ride."), frappe.PermissionError)
	doc.status = "Cancelled"
	doc.add_comment("Comment", text=f"Cancelled by driver: {reason or 'No reason given.'}")
	doc.save(ignore_permissions=True)

	# Refund any held bookings 100% (driver-cancellation rule).
	from rideshare.api.bookings import _refund_booking

	for b in frappe.get_all("Booking", filters={"ride": ride, "status": "Confirmed"}, pluck="name"):
		_refund_booking(b, percentage=100, reason="Driver cancelled the ride.")

	frappe.db.commit()
	return {"name": doc.name, "status": doc.status}
