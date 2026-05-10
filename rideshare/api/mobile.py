"""Mobile-tailored helpers.

These endpoints aggregate what a phone screen needs into one round-trip,
because every extra request on a mobile network costs noticeable latency.
"""

from __future__ import annotations

from typing import Any

import frappe
from frappe import _
from frappe.utils import get_datetime, now_datetime


@frappe.whitelist()
def home_dashboard() -> dict[str, Any]:
	"""Single payload for the app's Home screen: upcoming bookings (as
	passenger), upcoming rides (as driver), and any in-progress trip."""

	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	upcoming_bookings = frappe.db.sql(
		"""SELECT b.name, b.ride, b.status, b.seats_booked, b.total_amount,
		          r.origin_city, r.destination_city, r.departure_datetime,
		          r.driver, r.status AS ride_status
		   FROM `tabBooking` b
		   JOIN `tabRide` r ON r.name = b.ride
		   WHERE b.passenger = %(u)s
		     AND b.status IN ('Confirmed', 'Pending', 'InProgress')
		     AND r.departure_datetime >= NOW() - INTERVAL 1 DAY
		   ORDER BY r.departure_datetime ASC
		   LIMIT 10""",
		{"u": user},
		as_dict=True,
	)

	upcoming_rides = frappe.db.sql(
		"""SELECT name, origin_city, destination_city, departure_datetime,
		          status, seats_total, seats_available, price_per_seat
		   FROM `tabRide`
		   WHERE driver = %(u)s
		     AND status IN ('Published', 'Full', 'InProgress')
		     AND departure_datetime >= NOW() - INTERVAL 1 DAY
		   ORDER BY departure_datetime ASC
		   LIMIT 10""",
		{"u": user},
		as_dict=True,
	)

	# Active trip: a Confirmed booking whose ride is InProgress.
	active = frappe.db.sql(
		"""SELECT b.name AS booking, b.ride, r.driver,
		          r.origin_city, r.destination_city
		   FROM `tabBooking` b JOIN `tabRide` r ON r.name = b.ride
		   WHERE b.passenger = %(u)s AND r.status = 'InProgress'
		     AND b.status IN ('Confirmed', 'InProgress')
		   ORDER BY r.departure_datetime DESC LIMIT 1""",
		{"u": user},
		as_dict=True,
	)
	driver_active = frappe.db.get_value(
		"Ride",
		{"driver": user, "status": "InProgress"},
		["name", "origin_city", "destination_city"],
		as_dict=True,
	)

	return {
		"user": user,
		"upcoming_bookings": upcoming_bookings,
		"upcoming_rides": upcoming_rides,
		"active_trip_as_passenger": active[0] if active else None,
		"active_trip_as_driver": driver_active,
	}


@frappe.whitelist()
def ride_summary(ride: str) -> dict[str, Any]:
	"""Compact ride record for the booker's detail screen.

	Includes driver display info + waypoints in order so the client can
	render the vertical timeline without a second roundtrip.
	"""

	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	r = frappe.db.get_value(
		"Ride",
		ride,
		[
			"name", "driver", "vehicle", "status",
			"origin_city", "origin_address", "origin_lat", "origin_lng",
			"destination_city", "destination_address", "destination_lat", "destination_lng",
			"departure_datetime", "estimated_arrival",
			"distance_km", "duration_minutes",
			"seats_total", "seats_available",
			"price_per_seat", "currency",
			"instant_booking", "women_only", "max_2_back",
			"description", "cancellation_policy",
		],
		as_dict=True,
	)
	if not r:
		frappe.throw(_("Ride not found."))

	waypoints = frappe.get_all(
		"Ride Waypoint",
		filters={"parent": ride},
		fields=["city", "address", "lat", "lng", "stop_order", "estimated_arrival"],
		order_by="stop_order asc",
	)

	driver_user = frappe.db.get_value(
		"User", r.driver, ["full_name", "user_image"], as_dict=True
	) or {}
	driver_profile = frappe.db.get_value(
		"Driver Profile",
		{"user": r.driver},
		["name", "is_verified", "verification_status", "rating_avg", "rating_count", "bio"],
		as_dict=True,
	) or {}

	r["waypoints"] = waypoints
	r["driver_display"] = {
		"user": r.driver,
		"name": driver_user.get("full_name"),
		"image": driver_user.get("user_image"),
		**driver_profile,
	}
	return r
