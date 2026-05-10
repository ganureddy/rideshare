"""Driver-facing endpoints: publish a ride, manage own rides, suggest price."""

from __future__ import annotations

import json
import re
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
	suggested = round(distance_km * (min_per_km + max_per_km) / 2)
	return {
		"distance_km": round(distance_km, 1),
		"duration_minutes": duration_minutes,
		"min_price": round(distance_km * min_per_km),
		"max_price": round(distance_km * max_per_km),
		"suggested_price": int(suggested),
	}


@frappe.whitelist()
def list_cities(query: str | None = None, limit: int = 50) -> list[dict]:
	"""Return active City records, optionally filtered by ``query``.

	Search behaviour mirrors a Frappe Link field: the query is split on
	whitespace and every word must match somewhere in city_name / state /
	country (case-insensitive).  Results are ranked so exact matches and
	prefix matches surface above substring matches.

	When no query is supplied we return the most-used / alphabetically-first
	``limit`` cities so the picker is never empty.
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

	# Split into individual words; each one must match SOMEWHERE in the
	# searchable text so "ban kar" finds "Bangalore (Karnataka)".
	words = [w for w in re.split(r"\s+", q) if w]
	conditions: list[str] = []
	values: dict[str, Any] = {"q": q, "qprefix": f"{q}%", "qlike": f"%{q}%", "limit": limit}
	for i, w in enumerate(words):
		key = f"w{i}"
		values[key] = f"%{w}%"
		conditions.append(
			f"(city_name LIKE %({key})s OR state LIKE %({key})s OR country LIKE %({key})s)"
		)

	# Relevance score:
	#   3 = exact city match, 2 = city startswith, 1 = city contains, 0 = matched via state/country only
	rows = frappe.db.sql(
		f"""SELECT name AS id, city_name AS label, state, country, lat, lng, slug,
		           CASE
		               WHEN LOWER(city_name) = LOWER(%(q)s) THEN 3
		               WHEN city_name LIKE %(qprefix)s THEN 2
		               WHEN city_name LIKE %(qlike)s THEN 1
		               ELSE 0
		           END AS _score
		    FROM `tabCity`
		    WHERE is_active = 1 AND {" AND ".join(conditions)}
		    ORDER BY _score DESC, city_name ASC
		    LIMIT %(limit)s""",
		values,
		as_dict=True,
	)
	for r in rows:
		r.pop("_score", None)
	return rows


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
