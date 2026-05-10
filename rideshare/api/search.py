"""Public ride search.

Phase 4 deliverable.  Matches:
1. Direct origin → destination,
2. Segment match: origin/dest match a waypoint of a longer ride
   (so Delhi→Jaipur appears for Delhi→Jaipur→Mumbai).

Filters: women-only, instant-booking, max-price.
Sort: ``departure`` (default), ``price_asc``, ``price_desc``,
       ``duration``.
"""

from __future__ import annotations

from typing import Any

import frappe
from frappe.utils import cint, flt, get_datetime


@frappe.whitelist(allow_guest=True)
def search_rides(
	origin: str | None = None,
	destination: str | None = None,
	date: str | None = None,
	seats: int = 1,
	women_only: int = 0,
	instant_booking: int = 0,
	max_price: float | None = None,
	sort: str = "departure",
	limit: int = 25,
	offset: int = 0,
) -> dict[str, Any]:
	"""Return a list of matching published rides + facets."""

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

	conditions: list[str] = ["r.status = 'Published'", "r.seats_available >= %(seats)s"]
	values: dict[str, Any] = {"seats": seats_i}

	# Date filter: same calendar day (driver-local).
	if date:
		dt = get_datetime(date)
		conditions.append("DATE(r.departure_datetime) = %(date)s")
		values["date"] = dt.date()
	else:
		# Default: only future rides.
		conditions.append("r.departure_datetime >= NOW()")

	if women_only_b:
		conditions.append("r.women_only = 1")
	if instant_booking_b:
		conditions.append("r.instant_booking = 1")
	if max_price_f is not None:
		conditions.append("r.price_per_seat <= %(max_price)s")
		values["max_price"] = max_price_f

	# Origin/destination matching uses a UNION between direct rides and rides
	# whose waypoint chain contains the origin and destination in order.
	o_clause = ""
	d_clause = ""
	if origin:
		o_clause = """AND (
			r.origin_city = %(origin)s
			OR EXISTS (SELECT 1 FROM `tabRide Waypoint` rw
			            WHERE rw.parent = r.name AND rw.city = %(origin)s)
		)"""
		values["origin"] = origin
	if destination:
		d_clause = """AND (
			r.destination_city = %(destination)s
			OR EXISTS (SELECT 1 FROM `tabRide Waypoint` rw
			            WHERE rw.parent = r.name AND rw.city = %(destination)s)
		)"""
		values["destination"] = destination

	order = {
		"departure": "r.departure_datetime ASC",
		"price_asc": "r.price_per_seat ASC, r.departure_datetime ASC",
		"price_desc": "r.price_per_seat DESC, r.departure_datetime ASC",
		"duration": "r.duration_minutes ASC, r.departure_datetime ASC",
	}.get(sort, "r.departure_datetime ASC")

	values["limit"] = int(limit)
	values["offset"] = int(offset)
	conds = " AND ".join(conditions)

	rows = frappe.db.sql(
		f"""SELECT r.name, r.driver, r.origin_city, r.destination_city,
		           r.origin_address, r.destination_address,
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

	# Hydrate driver info.
	for row in rows:
		dp = frappe.db.get_value(
			"Driver Profile",
			{"user": row.driver},
			["full_name", "avg_rating", "total_trips", "is_verified"],
			as_dict=True,
		) or {}
		full_name = dp.get("full_name") or frappe.db.get_value(
			"User", row.driver, "full_name"
		) or "Driver"
		row["driver_name"] = full_name
		row["driver_initials"] = "".join(p[:1].upper() for p in full_name.split()[:2]) or "D"
		row["driver_avg_rating"] = float(dp.get("avg_rating") or 0)
		row["driver_total_trips"] = int(dp.get("total_trips") or 0)
		row["driver_is_verified"] = bool(dp.get("is_verified") or 0)

	return {
		"results": rows,
		"count": len(rows),
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
