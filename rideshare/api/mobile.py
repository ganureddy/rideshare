"""Mobile-tailored helpers.

These endpoints aggregate what a phone screen needs into one round-trip,
because every extra request on a mobile network costs noticeable latency.
"""

from __future__ import annotations

from typing import Any

import frappe
from frappe import _
from frappe.utils import now_datetime


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
		          r.driver, r.status AS ride_status,
		          r.price_per_seat
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
			"current_lat", "current_lng", "last_location_at",
		],
		as_dict=True,
	)
	if not r:
		frappe.throw(_("Ride not found."))

	# Ride Waypoint columns: sequence, city, lat, lng, pickup_offset_minutes.
	# Frontend consumed `stop_order` historically — alias it for compatibility.
	waypoints = frappe.get_all(
		"Ride Waypoint",
		filters={"parent": ride},
		fields=[
			"sequence as stop_order",
			"city",
			"lat",
			"lng",
			"pickup_offset_minutes",
		],
		order_by="sequence asc",
	)

	driver_user = frappe.db.get_value(
		"User", r.driver, ["full_name", "user_image", "first_name"], as_dict=True
	) or {}
	driver_profile = frappe.db.get_value(
		"Driver Profile",
		{"user": r.driver},
		[
			"name",
			"is_verified",
			"verification_status",
			"avg_rating",
			"total_reviews",
			"total_trips",
			"bio",
			"license_number",
			"license_expiry",
			"preferences_smoking",
			"preferences_pets",
			"preferences_music",
			"preferences_chat",
		],
		as_dict=True,
	) or {}

	# Vehicle details — booker wants to know what car they're getting into.
	# license_plate is a Password field; presence is enough for the booker UI.
	vehicle_doc = frappe.db.get_value(
		"Vehicle",
		r.vehicle,
		["name", "make", "model", "year", "color", "seats_available", "is_verified"],
		as_dict=True,
	) or {}
	has_plate = 0
	vehicle_photos: list[str] = []
	if vehicle_doc.get("name"):
		has_plate = 1 if frappe.db.get_value("Vehicle", vehicle_doc["name"], "license_plate") else 0
		# Surface every photo the driver attached so the booker can see
		# the actual car before committing.  Caption is intentionally
		# dropped — the UI is a simple gallery.
		vehicle_photos = [
			row.photo
			for row in frappe.get_all(
				"Vehicle Photo",
				filters={"parent": vehicle_doc["name"]},
				fields=["photo"],
				order_by="idx asc",
			)
			if row.photo
		]
	# license_number on Driver Profile is also stored encrypted.
	has_license = 0
	if driver_profile.get("name"):
		has_license = (
			1 if frappe.db.get_value("Driver Profile", driver_profile["name"], "license_number") else 0
		)

	r["waypoints"] = waypoints
	r["driver_display"] = {
		"user": r.driver,
		"name": driver_user.get("full_name") or driver_user.get("first_name") or "Driver",
		"image": driver_user.get("user_image"),
		"is_verified": bool(driver_profile.get("is_verified") or 0),
		"verification_status": driver_profile.get("verification_status"),
		"rating_avg": float(driver_profile.get("avg_rating") or 0),
		"rating_count": int(driver_profile.get("total_reviews") or 0),
		"total_trips": int(driver_profile.get("total_trips") or 0),
		"bio": driver_profile.get("bio"),
		"has_license": bool(has_license),
		"license_expiry": (
			driver_profile.get("license_expiry").isoformat()
			if driver_profile.get("license_expiry")
			else None
		),
	}
	r["preferences"] = {
		"music": driver_profile.get("preferences_music") or "Some",
		"chat": driver_profile.get("preferences_chat") or "Some",
		"smoking_ok": bool(driver_profile.get("preferences_smoking") or 0),
		"pets_ok": bool(driver_profile.get("preferences_pets") or 0),
	}
	r["vehicle_details"] = {
		"name": vehicle_doc.get("name"),
		"make": vehicle_doc.get("make"),
		"model": vehicle_doc.get("model"),
		"year": vehicle_doc.get("year"),
		"color": vehicle_doc.get("color"),
		"seats": vehicle_doc.get("seats_available"),
		"has_plate": bool(has_plate),
		"is_verified": bool(vehicle_doc.get("is_verified") or 0),
		"photos": vehicle_photos,
	}

	# Whether the calling user has already booked this ride — useful for the
	# detail screen to swap the CTA between "Book a seat" and "View booking".
	booking = frappe.db.get_value(
		"Booking",
		{"ride": ride, "passenger": user},
		["name", "status", "payment_status", "seats_booked", "total_amount"],
		as_dict=True,
	)
	r["my_booking"] = booking
	r["am_i_driver"] = r.driver == user

	# Contact details — only revealed once a booking actually exists between
	# the parties.  The driver sees every confirmed passenger's name + phone;
	# a passenger sees the driver's name + phone once their booking is
	# Confirmed (i.e. payment captured).
	r["contacts"] = _ride_contacts(ride, r.driver, user, booking)
	return r


def _ride_contacts(
	ride: str, driver: str, viewer: str, my_booking: dict | None
) -> dict[str, Any]:
	"""Return the set of contact details the ``viewer`` is allowed to see.

	Phone numbers are gated by the existence of a confirmed booking between
	the two parties — never leak a driver's phone to a passenger who hasn't
	paid, or a passenger's phone to anyone other than their booked driver.
	"""

	out: dict[str, Any] = {"driver": None, "passengers": []}

	driver_user = frappe.db.get_value(
		"User", driver, ["full_name", "first_name", "mobile_no"], as_dict=True
	) or {}
	driver_label = (
		driver_user.get("full_name") or driver_user.get("first_name") or "Driver"
	)

	am_i_driver = viewer == driver
	# A passenger sees the driver's number once their booking is Confirmed.
	passenger_can_see_driver = bool(
		my_booking and my_booking.get("status") == "Confirmed"
	)
	driver_phone = driver_user.get("mobile_no") if (
		am_i_driver or passenger_can_see_driver
	) else None
	out["driver"] = {
		"name": driver_label,
		"mobile_no": driver_phone,
		"can_call": bool(driver_phone),
	}

	if am_i_driver:
		# Driver sees every confirmed booker for this ride.
		rows = frappe.db.sql(
			"""SELECT b.name AS booking, b.passenger, b.seats_booked,
			          b.status,
			          u.full_name, u.first_name, u.mobile_no
			   FROM `tabBooking` b
			   JOIN `tabUser` u ON u.name = b.passenger
			   WHERE b.ride = %(r)s AND b.status = 'Confirmed'
			   ORDER BY b.booked_on ASC""",
			{"r": ride},
			as_dict=True,
		)
		out["passengers"] = [
			{
				"booking": p["booking"],
				"user": p["passenger"],
				"name": p["full_name"] or p["first_name"] or "Passenger",
				"mobile_no": p["mobile_no"],
				"seats_booked": int(p["seats_booked"] or 0),
			}
			for p in rows
		]
	return out


@frappe.whitelist()
def trip_history(limit: int = 50) -> dict[str, Any]:
	"""Return ALL past bookings (as passenger) and rides (as driver).

	The Trips screen calls ``home_dashboard`` for upcoming items; this is
	the companion call for the History view.  Because bookings and rides
	are keyed on the user (mobile-derived ID), uninstalling the app and
	logging back in with the same number returns the same history.
	"""

	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	limit = int(limit or 50)

	past_bookings = frappe.db.sql(
		"""SELECT b.name, b.ride, b.status, b.seats_booked, b.total_amount,
		          b.payment_status,
		          r.origin_city, r.destination_city, r.departure_datetime,
		          r.driver, r.status AS ride_status,
		          r.price_per_seat
		   FROM `tabBooking` b
		   JOIN `tabRide` r ON r.name = b.ride
		   WHERE b.passenger = %(u)s
		     AND (
		       r.status IN ('Completed', 'Cancelled')
		       OR b.status = 'Cancelled'
		       OR r.departure_datetime < NOW() - INTERVAL 1 DAY
		     )
		   ORDER BY r.departure_datetime DESC
		   LIMIT %(limit)s""",
		{"u": user, "limit": limit},
		as_dict=True,
	)

	past_rides = frappe.db.sql(
		"""SELECT name, origin_city, destination_city, departure_datetime,
		          status, seats_total, seats_available, price_per_seat
		   FROM `tabRide`
		   WHERE driver = %(u)s
		     AND (
		       status IN ('Completed', 'Cancelled')
		       OR departure_datetime < NOW() - INTERVAL 1 DAY
		     )
		   ORDER BY departure_datetime DESC
		   LIMIT %(limit)s""",
		{"u": user, "limit": limit},
		as_dict=True,
	)

	return {
		"user": user,
		"past_bookings": past_bookings,
		"past_rides": past_rides,
	}


@frappe.whitelist()
def my_vehicles_summary() -> dict[str, Any]:
	"""Lightweight payload for the in-app driver onboarding screen."""

	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	vehicles = frappe.get_all(
		"Vehicle",
		filters={"owner_user": user},
		fields=["name", "make", "model", "year", "color", "seats_available", "is_verified"],
		order_by="creation desc",
	)
	# Hydrate each vehicle with its photo gallery + license plate so the
	# publish wizard can pre-fill on the next ride.  The plate is stored
	# as a Password field on Vehicle (encrypted at rest), so we have to
	# decrypt explicitly — frappe.get_all wouldn't have returned it
	# anyway.  We only ever surface it back to the row's owner, so the
	# decrypt is safe.
	from frappe.utils.password import get_decrypted_password

	for v in vehicles:
		v["photos"] = [
			row.photo
			for row in frappe.get_all(
				"Vehicle Photo",
				filters={"parent": v["name"]},
				fields=["photo"],
				order_by="idx asc",
			)
			if row.photo
		]
		try:
			v["license_plate"] = (
				get_decrypted_password("Vehicle", v["name"], "license_plate", raise_exception=False)
				or None
			)
		except Exception:
			v["license_plate"] = None
	user_image = frappe.db.get_value("User", user, "user_image")
	driver_profile = frappe.db.get_value(
		"Driver Profile",
		{"user": user},
		[
			"name",
			"is_verified",
			"verification_status",
			"bio",
			"full_name",
			"license_expiry",
			"preferences_music",
			"preferences_chat",
			"preferences_smoking",
			"preferences_pets",
		],
		as_dict=True,
	)
	if driver_profile:
		if driver_profile.get("license_expiry"):
			driver_profile["license_expiry"] = driver_profile["license_expiry"].isoformat()
		# Same encrypted-Password story as vehicle.license_plate above.
		try:
			driver_profile["license_number"] = (
				get_decrypted_password(
					"Driver Profile", driver_profile["name"], "license_number",
					raise_exception=False,
				)
				or None
			)
		except Exception:
			driver_profile["license_number"] = None
	return {
		"vehicles": vehicles,
		"driver_profile": driver_profile,
		"driver_photo": user_image,
		"can_publish": bool(driver_profile) and bool(vehicles),
	}
