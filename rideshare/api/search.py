"""Public ride search.

Phase 4 deliverable.  Matches:
1. Direct origin → destination (exact City Link match).
2. Segment match: origin/dest match a waypoint of a longer ride
   (so Delhi → Mumbai appears for Delhi → Pune when Pune is a waypoint).
3. Proximity match: when the caller provides lat/lng (the mobile app
   does, for free-text Google Places that aren't in our City table) we
   include rides whose great-circle distance to the caller's origin and
   destination is within a small radius — the bbox SQL pre-filter keeps
   it cheap, and a Python rerank trims the long tail.

Filters: women-only, instant-booking, max-price.
Sort: ``departure`` (default), ``price_asc``, ``price_desc``,
       ``duration``.
"""

from __future__ import annotations

import math
from typing import Any

import frappe
from frappe.utils import cint, flt, get_datetime

from rideshare.utils.geo import LatLng, haversine_km

# How close a ride's origin / destination / waypoint must be to count as a
# proximity match. 50km lets "Delhi" match "New Delhi" / "Gurgaon" too.
PROXIMITY_RADIUS_KM = 50.0


@frappe.whitelist(allow_guest=True)
def search_rides(
	origin: str | None = None,
	destination: str | None = None,
	origin_lat: float | None = None,
	origin_lng: float | None = None,
	destination_lat: float | None = None,
	destination_lng: float | None = None,
	date: str | None = None,
	seats: int = 1,
	women_only: int = 0,
	instant_booking: int = 0,
	max_price: float | None = None,
	sort: str = "departure",
	limit: int = 25,
	offset: int = 0,
) -> dict[str, Any]:
	"""Return matching published rides.

	The frontend can pass either a ``origin/destination`` City label *or*
	a lat/lng pair.  Lat/lng wins for proximity matching; the City label
	is used as a fast equality filter first.
	"""

	# Frappe passes whitelisted args as strings from form-encoded requests,
	# so "0" is truthy in plain bool checks.  Coerce booleans/numbers up front.
	women_only_b = bool(cint(women_only))
	instant_booking_b = bool(cint(instant_booking))
	seats_i = cint(seats) or 1
	max_price_f: float | None = None
	if max_price not in (None, "", "null"):
		try:
			max_price_f = flt(max_price)
		except (TypeError, ValueError):
			max_price_f = None

	o_lat = _flt(origin_lat)
	o_lng = _flt(origin_lng)
	d_lat = _flt(destination_lat)
	d_lng = _flt(destination_lng)

	conditions: list[str] = ["r.status = 'Published'", "r.seats_available >= %(seats)s"]
	values: dict[str, Any] = {"seats": seats_i}

	# Date filter: same calendar day (driver-local).
	if date:
		dt = get_datetime(date)
		conditions.append("DATE(r.departure_datetime) = %(date)s")
		values["date"] = dt.date()
	else:
		conditions.append("r.departure_datetime >= NOW()")

	if women_only_b:
		conditions.append("r.women_only = 1")
	if instant_booking_b:
		conditions.append("r.instant_booking = 1")
	if max_price_f is not None:
		conditions.append("r.price_per_seat <= %(max_price)s")
		values["max_price"] = max_price_f

	# Origin / destination matching: combine label-based and (when lat/lng
	# supplied) bounding-box proximity.  Both go in the SQL WHERE so the
	# planner can use indexes; we then re-rank the candidate set with
	# haversine for proximity precision.
	o_clause = _label_or_proximity_clause(
		"origin", "origin_city", "origin_lat", "origin_lng",
		label=origin, lat=o_lat, lng=o_lng, values=values,
	)
	d_clause = _label_or_proximity_clause(
		"destination", "destination_city", "destination_lat", "destination_lng",
		label=destination, lat=d_lat, lng=d_lng, values=values,
	)

	order = {
		"departure": "r.departure_datetime ASC",
		"price_asc": "r.price_per_seat ASC, r.departure_datetime ASC",
		"price_desc": "r.price_per_seat DESC, r.departure_datetime ASC",
		"duration": "r.duration_minutes ASC, r.departure_datetime ASC",
	}.get(sort, "r.departure_datetime ASC")

	values["limit"] = int(limit) * 2  # over-fetch so the rerank has room
	values["offset"] = int(offset)
	conds = " AND ".join(conditions)

	rows = frappe.db.sql(
		f"""SELECT r.name, r.driver, r.origin_city, r.destination_city,
		           r.origin_address, r.destination_address,
		           r.origin_lat, r.origin_lng,
		           r.destination_lat, r.destination_lng,
		           r.departure_datetime, r.estimated_arrival,
		           r.distance_km, r.duration_minutes,
		           r.seats_total, r.seats_available,
		           r.price_per_seat, r.currency,
		           r.instant_booking, r.women_only, r.max_2_back,
		           r.description
		    FROM `tabRide` r
		    WHERE {conds} {o_clause} {d_clause}
		    ORDER BY {order}
		    LIMIT %(limit)s OFFSET %(offset)s""",
		values,
		as_dict=True,
	)

	# Proximity precision rerank — drop rows that passed the bbox but are
	# actually outside the haversine radius.  Pull waypoints in one shot.
	if (o_lat and o_lng) or (d_lat and d_lng):
		rows = _rerank_by_proximity(
			rows,
			o_lat=o_lat, o_lng=o_lng,
			d_lat=d_lat, d_lng=d_lng,
		)
	rows = rows[: int(limit)]

	# Hydrate driver + vehicle info.  We bulk-fetch in one go for the
	# whole result set rather than per-row to keep this endpoint snappy
	# even with the over-fetch buffer.
	driver_ids = list({r.driver for r in rows if r.driver})
	dp_by_user: dict[str, dict] = {}
	if driver_ids:
		for dp in frappe.db.get_all(
			"Driver Profile",
			filters={"user": ["in", driver_ids]},
			fields=["user", "full_name", "avg_rating", "total_reviews", "total_trips", "is_verified"],
		):
			dp_by_user[dp["user"]] = dp

	# Driver display-name fallback when there's no Driver Profile yet.
	user_meta: dict[str, dict] = {}
	if driver_ids:
		for u in frappe.db.get_all(
			"User",
			filters={"name": ["in", driver_ids]},
			fields=["name", "full_name", "user_image"],
		):
			user_meta[u["name"]] = u

	# First photo per ride — bulk fetch the front-most car shot for
	# every distinct vehicle in the result set.  Drives the search
	# card thumbnail.
	ride_to_vehicle: dict[str, str] = {}
	for r in rows:
		v = frappe.db.get_value("Ride", r.name, "vehicle")
		if v:
			ride_to_vehicle[r.name] = v
	first_photo_by_vehicle: dict[str, str] = {}
	if ride_to_vehicle:
		for vp in frappe.db.sql(
			"""SELECT parent, photo
			   FROM `tabVehicle Photo`
			   WHERE parent IN %(ids)s AND photo IS NOT NULL
			   ORDER BY idx ASC""",
			{"ids": tuple(set(ride_to_vehicle.values()))},
			as_dict=True,
		):
			first_photo_by_vehicle.setdefault(vp["parent"], vp["photo"])

	for row in rows:
		dp = dp_by_user.get(row.driver, {}) or {}
		um = user_meta.get(row.driver, {}) or {}
		full_name = dp.get("full_name") or um.get("full_name") or "Driver"
		row["driver_name"] = full_name
		row["driver_initials"] = "".join(p[:1].upper() for p in full_name.split()[:2]) or "D"
		row["driver_image"] = um.get("user_image") or None
		row["driver_avg_rating"] = float(dp.get("avg_rating") or 0)
		row["driver_total_reviews"] = int(dp.get("total_reviews") or 0)
		row["driver_total_trips"] = int(dp.get("total_trips") or 0)
		row["driver_is_verified"] = bool(dp.get("is_verified") or 0)
		# Vehicle thumb — first uploaded photo.  Falls back to null,
		# the client renders an Ionicons placeholder in that case.
		veh = ride_to_vehicle.get(row.name)
		row["vehicle_photo"] = first_photo_by_vehicle.get(veh) if veh else None

	# Compatibility: keep both `rides` (new) and `results` (legacy) keys.
	return {
		"rides": rows,
		"results": rows,
		"count": len(rows),
		"total": len(rows),
		"filters": {
			"origin": origin,
			"destination": destination,
			"date": date,
			"seats": seats_i,
			"women_only": women_only_b,
			"instant_booking": instant_booking_b,
			"max_price": max_price_f,
			"sort": sort,
		},
	}


def _label_or_proximity_clause(
	tag: str,
	city_col: str,
	lat_col: str,
	lng_col: str,
	*,
	label: str | None,
	lat: float | None,
	lng: float | None,
	values: dict[str, Any],
) -> str:
	"""Build the AND-clause for either ``origin`` or ``destination``.

	The result OR's together (a) exact city match, (b) waypoint match,
	(c) bounding-box proximity match (when a lat/lng pair is given).
	"""

	parts: list[str] = []
	if label:
		# Exact City record name (fast indexed match).
		values[f"{tag}_label"] = label
		parts.append(f"r.{city_col} = %({tag}_label)s")
		# Waypoint match — the driver's published intermediate stops.
		parts.append(
			f"""EXISTS (SELECT 1 FROM `tabRide Waypoint` rw
			            WHERE rw.parent = r.name AND rw.city = %({tag}_label)s)"""
		)
	if lat and lng:
		# Bounding-box pre-filter for the ride's origin / destination, plus
		# any waypoint inside the radius — covers "A→Z appears for A→M".
		min_lat, min_lng, max_lat, max_lng = _bbox(lat, lng, PROXIMITY_RADIUS_KM)
		values[f"{tag}_min_lat"] = min_lat
		values[f"{tag}_max_lat"] = max_lat
		values[f"{tag}_min_lng"] = min_lng
		values[f"{tag}_max_lng"] = max_lng
		parts.append(
			f"""(r.{lat_col} BETWEEN %({tag}_min_lat)s AND %({tag}_max_lat)s
			     AND r.{lng_col} BETWEEN %({tag}_min_lng)s AND %({tag}_max_lng)s)"""
		)
		parts.append(
			f"""EXISTS (SELECT 1 FROM `tabRide Waypoint` rw
			            WHERE rw.parent = r.name
			              AND rw.lat BETWEEN %({tag}_min_lat)s AND %({tag}_max_lat)s
			              AND rw.lng BETWEEN %({tag}_min_lng)s AND %({tag}_max_lng)s)"""
		)

	if not parts:
		return ""
	return "AND (" + " OR ".join(parts) + ")"


def _bbox(lat: float, lng: float, radius_km: float) -> tuple[float, float, float, float]:
	lat_delta = radius_km / 111.0
	lng_delta = radius_km / (111.0 * max(math.cos(math.radians(lat)), 1e-6))
	return (lat - lat_delta, lng - lng_delta, lat + lat_delta, lng + lng_delta)


def _rerank_by_proximity(
	rows: list[dict],
	*,
	o_lat: float | None,
	o_lng: float | None,
	d_lat: float | None,
	d_lng: float | None,
) -> list[dict]:
	"""Drop rows where the ride doesn't pass within ``PROXIMITY_RADIUS_KM``
	of both the requested origin and destination (when supplied)."""

	# Pre-load all waypoints once for the candidate set.
	ride_names = [r.name for r in rows]
	waypoints_by_ride: dict[str, list[tuple[float, float]]] = {n: [] for n in ride_names}
	if ride_names:
		for w in frappe.db.sql(
			"""SELECT parent, lat, lng FROM `tabRide Waypoint`
			   WHERE parent IN %(p)s AND lat IS NOT NULL AND lng IS NOT NULL""",
			{"p": ride_names},
			as_dict=True,
		):
			waypoints_by_ride.setdefault(w.parent, []).append((w.lat, w.lng))

	keep: list[dict] = []
	for row in rows:
		ok_o = ok_d = True
		if o_lat and o_lng:
			ok_o = _hits(o_lat, o_lng, row.origin_lat, row.origin_lng,
			             waypoints_by_ride.get(row.name) or [])
		if d_lat and d_lng:
			# Order matters for trips: the destination must come after the
			# origin in the route. Easy approximation: a waypoint counts
			# only if it isn't closer to the origin than the actual origin.
			ok_d = _hits(d_lat, d_lng, row.destination_lat, row.destination_lng,
			             waypoints_by_ride.get(row.name) or [])
		if ok_o and ok_d:
			keep.append(row)
	return keep


def _hits(lat: float, lng: float, ride_lat: float | None, ride_lng: float | None,
          waypoints: list[tuple[float, float]]) -> bool:
	target = LatLng(lat, lng)
	if ride_lat and ride_lng:
		try:
			if haversine_km(target, LatLng(float(ride_lat), float(ride_lng))) <= PROXIMITY_RADIUS_KM:
				return True
		except Exception:
			pass
	for wlat, wlng in waypoints:
		try:
			if haversine_km(target, LatLng(float(wlat), float(wlng))) <= PROXIMITY_RADIUS_KM:
				return True
		except Exception:
			continue
	return False


def _flt(v) -> float | None:
	if v is None or v == "":
		return None
	try:
		return float(v)
	except (TypeError, ValueError):
		return None


@frappe.whitelist(allow_guest=True)
def get_ride(name: str) -> dict:
	"""Public ride detail used by ``/rides/<name>``."""

	doc = frappe.get_doc("Ride", name)
	if doc.status not in ("Published", "Full", "InProgress"):
		frappe.throw(frappe._("Ride not available."))

	dp = (
		frappe.db.get_value(
			"Driver Profile",
			{"user": doc.driver},
			[
				"full_name",
				"bio",
				"avg_rating",
				"total_trips",
				"is_verified",
				"preferences_smoking",
				"preferences_pets",
				"preferences_music",
				"preferences_chat",
			],
			as_dict=True,
		)
		or {}
	)
	dp.setdefault("full_name", frappe.db.get_value("User", doc.driver, "full_name") or "Driver")

	veh = frappe.db.get_value(
		"Vehicle", doc.vehicle, ["make", "model", "year", "color"], as_dict=True
	) or {}

	return {
		"ride": doc.as_dict(),
		"driver": {
			"user": doc.driver,
			"name": dp.get("full_name"),
			"bio": dp.get("bio"),
			"avg_rating": float(dp.get("avg_rating") or 0),
			"total_trips": int(dp.get("total_trips") or 0),
			"is_verified": bool(dp.get("is_verified") or 0),
			"preferences_smoking": bool(dp.get("preferences_smoking") or 0),
			"preferences_pets": bool(dp.get("preferences_pets") or 0),
			"preferences_music": dp.get("preferences_music"),
			"preferences_chat": dp.get("preferences_chat"),
		},
		"vehicle": veh,
	}
