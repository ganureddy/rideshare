"""Live driver + passenger location tracking.

Wire model
----------
Both roles run ``expo-location`` on the device and POST their GPS fix
here.  GPS is a free OS-level capability — there is no Google API or
geolocation-API cost involved.  Map tiles in the app come from
OpenStreetMap (also free), and route + ETA come from OSRM via
``rideshare.api.routing`` (also free).

  * **Driver** → ``push_location``: writes to ``Ride.current_*`` and
    broadcasts ``rideshare:location`` on room ``ride:<name>``.
  * **Passenger** → ``push_passenger_location``: writes to
    ``Booking.passenger_*`` and broadcasts
    ``rideshare:passenger_location`` on the same room.

Both sides subscribe to ``ride:<name>`` over Frappe's Socket.IO bridge,
falling back to REST polling (``get_last_location`` /
``get_passenger_locations``) when the socket drops.

Why store on the Ride/Booking row instead of a TimeSeries DocType?
------------------------------------------------------------------
For "where are they right now?" we only ever need the *latest* fix.
~12 fixes/min × every active ride/booking would inflate I/O by 100× with
zero product value at MVP.  We can promote this to a
``Ride Location Trace`` child table later if we want replay.
"""

from __future__ import annotations

import time

import frappe
from frappe import _
from frappe.utils import now_datetime

# In-memory throttle: collapse pushes to at-most-one-per-second per actor.
# Stored on the Frappe local site cache so multiple gunicorn workers each
# get their own bucket — this is fine; the goal is to dampen runaway
# clients, not to be cluster-precise.
_THROTTLE_NS = "rideshare:tracking:last_push"
_THROTTLE_PAX_NS = "rideshare:tracking:last_push:pax"


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
	_push_trip_status(ride_name, event="started")
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
	_push_trip_status(ride_name, event="completed")
	return {"status": "Completed"}


def _push_trip_status(ride_name: str, *, event: str) -> None:
	"""Notify every confirmed passenger when the driver starts / ends the trip."""

	try:
		from rideshare.utils.push import notify_user
	except Exception:
		return

	ride = frappe.db.get_value(
		"Ride",
		ride_name,
		["origin_city", "destination_city"],
		as_dict=True,
	) or {}
	route = f"{ride.get('origin_city') or 'pickup'} → {ride.get('destination_city') or 'destination'}"

	passengers = frappe.get_all(
		"Booking",
		filters={
			"ride": ride_name,
			"status": ["in", ("Confirmed", "InProgress")],
		},
		pluck="passenger",
	)

	if event == "started":
		title = "Your ride has started"
		body = f"The driver is on the way for {route}. Tap to follow live."
	else:
		title = "Trip completed"
		body = f"You've arrived in {ride.get('destination_city') or 'your destination'}. Hope it went well!"

	data = {"type": "trip", "event": event, "ride": ride_name}
	for u in set(passengers):
		notify_user(u, title=title, body=body, data=data, channel="trip")


# ---------------------------------------------------------------------------
# Passenger-side tracking
# ---------------------------------------------------------------------------


def _booking_for_passenger(booking_name: str, user: str) -> dict:
	"""Validate the caller owns this booking; return ``{name, ride}``."""

	row = frappe.db.get_value(
		"Booking",
		booking_name,
		["name", "ride", "passenger", "status"],
		as_dict=True,
	)
	if not row:
		frappe.throw(_("Booking not found."))
	if row.passenger != user:
		frappe.throw(
			_("Only the passenger can push their location for this booking."),
			frappe.PermissionError,
		)
	if row.status not in ("Confirmed", "Pending", "InProgress"):
		frappe.throw(
			_("Booking is {0}; tracking not allowed.").format(row.status),
			frappe.ValidationError,
		)
	return row


@frappe.whitelist()
def push_passenger_location(
	booking: str,
	lat: float,
	lng: float,
	heading: float | None = None,
	speed_kmh: float | None = None,
) -> dict:
	"""Passenger pushes a single GPS fix during an active booking.

	Mirrors :func:`push_location` but writes to the Booking row and
	broadcasts ``rideshare:passenger_location`` on ``ride:<ride>``.
	"""

	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	row = _booking_for_passenger(booking, user)

	cache = frappe.cache()
	last = cache.hget(_THROTTLE_PAX_NS, booking)
	now_mono = time.monotonic()
	if last and (now_mono - float(last)) < 1.0:
		return {"throttled": True}
	cache.hset(_THROTTLE_PAX_NS, booking, now_mono)

	lat_f, lng_f = float(lat), float(lng)
	if not (-90 <= lat_f <= 90 and -180 <= lng_f <= 180):
		frappe.throw(_("Invalid coordinates."), frappe.ValidationError)

	now_dt = now_datetime()
	frappe.db.set_value(
		"Booking",
		booking,
		{
			"passenger_lat": lat_f,
			"passenger_lng": lng_f,
			"passenger_heading": float(heading) if heading is not None else None,
			"passenger_speed_kmh": float(speed_kmh) if speed_kmh is not None else None,
			"passenger_last_seen_at": now_dt,
		},
		update_modified=False,
	)
	frappe.db.commit()

	payload = {
		"ride": row.ride,
		"booking": booking,
		"passenger": user,
		"lat": lat_f,
		"lng": lng_f,
		"heading": heading,
		"speed_kmh": speed_kmh,
		"at": now_dt.isoformat(),
	}
	frappe.publish_realtime(
		event="rideshare:passenger_location",
		message=payload,
		room=f"ride:{row.ride}",
		after_commit=False,
	)
	return {"ok": True, "at": now_dt.isoformat()}


@frappe.whitelist()
def get_passenger_locations(ride: str) -> dict:
	"""Return the latest passenger fixes for every active booking on a ride.

	Driver-only.  Used by the driver's Tracking screen to render every
	passenger pin (so the driver can see where to pick everyone up) and
	by REST polling when the socket disconnects.
	"""

	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)
	# Allow driver, support, and any passenger of this ride to read.  This
	# is the same trust boundary as `get_last_location`.
	if not _booker_can_view(ride, user):
		frappe.throw(_("Not authorised to track this ride."), frappe.PermissionError)

	bookings = frappe.get_all(
		"Booking",
		filters={
			"ride": ride,
			"status": ["in", ("Confirmed", "Pending", "InProgress")],
		},
		fields=[
			"name",
			"passenger",
			"status",
			"seats_booked",
			"passenger_lat",
			"passenger_lng",
			"passenger_heading",
			"passenger_speed_kmh",
			"passenger_last_seen_at",
		],
	)

	now = now_datetime()
	out = []
	for b in bookings:
		stale_seconds = None
		if b.passenger_last_seen_at:
			stale_seconds = int((now - b.passenger_last_seen_at).total_seconds())
		out.append(
			{
				"booking": b.name,
				"passenger": b.passenger,
				"status": b.status,
				"seats_booked": b.seats_booked,
				"lat": b.passenger_lat,
				"lng": b.passenger_lng,
				"heading": b.passenger_heading,
				"speed_kmh": b.passenger_speed_kmh,
				"at": b.passenger_last_seen_at.isoformat()
				if b.passenger_last_seen_at
				else None,
				"stale_seconds": stale_seconds,
				"available": b.passenger_lat is not None,
			}
		)
	return {"ride": ride, "passengers": out}
