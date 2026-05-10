"""Live driver location tracking.

Wire model
----------
Driver app: holds a foreground service (Expo BackgroundLocationTask /
react-native-background-geolocation in production) that POSTs the latest
GPS fix to ``push_location`` every 5 seconds.

Server: writes the fix to the Ride row (so REST polling works as a
fallback) **and** publishes it on the ``ride:<name>`` realtime channel
via Frappe's Socket.IO bridge.

Booker app: subscribes to ``ride:<name>`` for instant updates and falls
back to ``get_last_location`` polling on mobile networks where the WS
connection is flaky.

Why store on the Ride row instead of a TimeSeries DocType?
----------------------------------------------------------
For the booker, only "where is my driver right now?" matters. A bookings-
heavy carpool route generates ~12 fixes/min — keeping a full breadcrumb
table inflates I/O 100× without product value at MVP.  We can promote
this into a ``Ride Location Trace`` child table later if we need replay.
"""

from __future__ import annotations

import time

import frappe
from frappe import _
from frappe.utils import now_datetime

# In-memory throttle: collapse pushes to at-most-one-per-second per ride.
# Stored on the Frappe local site cache so multiple gunicorn workers each
# get their own bucket — this is fine; the goal is to dampen runaway
# clients, not to be cluster-precise.
_THROTTLE_NS = "rideshare:tracking:last_push"


def _ride_for_driver(ride_name: str, user: str) -> str:
	"""Validate that ``user`` is the driver on ``ride_name``; return ride doc name."""

	driver = frappe.db.get_value("Ride", ride_name, "driver")
	if not driver:
		frappe.throw(_("Ride not found."))
	if driver != user:
		frappe.throw(_("Only the driver can push locations for this ride."), frappe.PermissionError)
	return ride_name


def _booker_can_view(ride_name: str, user: str) -> bool:
	"""A user may follow a ride if they're its driver, or have a confirmed
	or in-progress booking on it."""

	row = frappe.db.get_value("Ride", ride_name, ["driver", "status"], as_dict=True)
	if not row:
		return False
	if row.driver == user:
		return True
	booking_status = frappe.db.get_value(
		"Booking", {"ride": ride_name, "passenger": user}, "status"
	)
	return booking_status in ("Confirmed", "InProgress", "Completed")


@frappe.whitelist()
def push_location(
	ride: str,
	lat: float,
	lng: float,
	heading: float | None = None,
	speed_kmh: float | None = None,
) -> dict:
	"""Driver pushes a single GPS fix.

	Returns the wall-clock time the server accepted the fix; the client uses
	this to detect clock-skew and back-off scenarios.
	"""

	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	ride_name = _ride_for_driver(ride, user)

	# Throttle: ignore pushes within 1s for the same ride.
	cache = frappe.cache()
	last = cache.hget(_THROTTLE_NS, ride_name)
	now_mono = time.monotonic()
	if last and (now_mono - float(last)) < 1.0:
		return {"throttled": True}
	cache.hset(_THROTTLE_NS, ride_name, now_mono)

	lat_f, lng_f = float(lat), float(lng)
	if not (-90 <= lat_f <= 90 and -180 <= lng_f <= 180):
		frappe.throw(_("Invalid coordinates."), frappe.ValidationError)

	now_dt = now_datetime()
	frappe.db.set_value(
		"Ride",
		ride_name,
		{
			"current_lat": lat_f,
			"current_lng": lng_f,
			"current_heading": float(heading) if heading is not None else None,
			"current_speed_kmh": float(speed_kmh) if speed_kmh is not None else None,
			"last_location_at": now_dt,
		},
		update_modified=False,
	)
	frappe.db.commit()

	payload = {
		"ride": ride_name,
		"lat": lat_f,
		"lng": lng_f,
		"heading": heading,
		"speed_kmh": speed_kmh,
		"at": now_dt.isoformat(),
	}
	# Broadcast to all subscribers of this ride.
	frappe.publish_realtime(
		event="rideshare:location",
		message=payload,
		room=f"ride:{ride_name}",
		after_commit=False,
	)
	return {"ok": True, "at": now_dt.isoformat()}


@frappe.whitelist()
def get_last_location(ride: str) -> dict:
	"""Polling fallback for the booker app when the realtime socket drops.

	Returns the most recent fix and a `stale_seconds` hint so the UI can
	surface "Driver lost signal — last seen 23s ago" without a wall-clock
	calculation on-device.
	"""

	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)
	if not _booker_can_view(ride, user):
		frappe.throw(_("Not authorised to track this ride."), frappe.PermissionError)

	row = frappe.db.get_value(
		"Ride",
		ride,
		[
			"current_lat",
			"current_lng",
			"current_heading",
			"current_speed_kmh",
			"last_location_at",
			"status",
			"origin_lat",
			"origin_lng",
			"destination_lat",
			"destination_lng",
		],
		as_dict=True,
	)
	if not row or row.current_lat is None:
		return {"available": False, "status": (row or {}).get("status")}

	stale_seconds = None
	if row.last_location_at:
		stale_seconds = int((now_datetime() - row.last_location_at).total_seconds())

	return {
		"available": True,
		"lat": row.current_lat,
		"lng": row.current_lng,
		"heading": row.current_heading,
		"speed_kmh": row.current_speed_kmh,
		"at": row.last_location_at.isoformat() if row.last_location_at else None,
		"stale_seconds": stale_seconds,
		"status": row.status,
		"origin": {"lat": row.origin_lat, "lng": row.origin_lng},
		"destination": {"lat": row.destination_lat, "lng": row.destination_lng},
	}


@frappe.whitelist()
def start_trip(ride: str) -> dict:
	"""Driver flips the ride to InProgress; booker apps move to the live map."""

	user = frappe.session.user
	ride_name = _ride_for_driver(ride, user)
	frappe.db.set_value("Ride", ride_name, "status", "InProgress")
	frappe.db.commit()
	frappe.publish_realtime(
		event="rideshare:status",
		message={"ride": ride_name, "status": "InProgress"},
		room=f"ride:{ride_name}",
	)
	return {"status": "InProgress"}


@frappe.whitelist()
def complete_trip(ride: str) -> dict:
	"""Driver flips the ride to Completed.  Escrow release is handled by the
	scheduler in ``rideshare.tasks.hourly.release_due_escrows``."""

	user = frappe.session.user
	ride_name = _ride_for_driver(ride, user)
	frappe.db.set_value("Ride", ride_name, "status", "Completed")
	frappe.db.commit()
	frappe.publish_realtime(
		event="rideshare:status",
		message={"ride": ride_name, "status": "Completed"},
		room=f"ride:{ride_name}",
	)
	return {"status": "Completed"}
