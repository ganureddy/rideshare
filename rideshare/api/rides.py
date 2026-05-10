"""Driver-facing endpoints: publish a ride, manage own rides, suggest price."""

from __future__ import annotations

import json

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
def list_cities(query: str | None = None, limit: int = 12) -> list[dict]:
	filters: dict = {"is_active": 1}
	if query:
		filters["city_name"] = ["like", f"%{query}%"]
	return frappe.get_all(
		"City",
		filters=filters,
		fields=["name as id", "city_name as label", "state", "lat", "lng", "slug"],
		order_by="city_name asc",
		limit_page_length=int(limit),
	)


@frappe.whitelist(allow_guest=True)
def list_cities_public(query: str | None = None, limit: int = 12) -> list[dict]:
	"""Public version used by the homepage search box."""

	return list_cities(query=query, limit=limit)


@frappe.whitelist()
def publish_ride(payload: str) -> dict:
	"""Create a Ride from the publish-wizard payload and mark Published.

	``payload`` is a JSON string with the same shape as the wizard form
	(see ``/publish``).  We accept JSON to keep the wire payload small.
	"""

	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	data = json.loads(payload) if isinstance(payload, str) else dict(payload)

	# Driver must have a Driver Profile (auto-create-on-onboard happens via
	# the wizard; we just guard here).
	if not frappe.db.exists("Driver Profile", {"user": user}):
		frappe.throw(_("Complete driver onboarding first."), frappe.ValidationError)

	doc = frappe.new_doc("Ride")
	doc.driver = user
	doc.vehicle = data.get("vehicle")
	doc.origin_city = data.get("origin_city")
	doc.origin_address = data.get("origin_address")
	doc.origin_lat = data.get("origin_lat")
	doc.origin_lng = data.get("origin_lng")
	doc.destination_city = data.get("destination_city")
	doc.destination_address = data.get("destination_address")
	doc.destination_lat = data.get("destination_lat")
	doc.destination_lng = data.get("destination_lng")
	doc.departure_datetime = data.get("departure_datetime")
	doc.seats_total = int(data.get("seats_total") or 3)
	doc.price_per_seat = float(data.get("price_per_seat") or 0)
	doc.instant_booking = int(bool(data.get("instant_booking")))
	doc.women_only = int(bool(data.get("women_only")))
	doc.max_2_back = int(bool(data.get("max_2_back", 1)))
	doc.description = data.get("description")
	doc.cancellation_policy = data.get("cancellation_policy") or "Moderate"

	for idx, w in enumerate(data.get("waypoints") or [], start=1):
		doc.append(
			"waypoints",
			{
				"sequence": idx,
				"city": w.get("city"),
				"lat": w.get("lat"),
				"lng": w.get("lng"),
				"pickup_offset_minutes": int(w.get("pickup_offset_minutes") or 0),
			},
		)

	doc.status = "Published"
	doc.flags.ignore_permissions = True
	doc.insert(ignore_permissions=True)
	frappe.db.commit()

	return {"name": doc.name, "status": doc.status}


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
