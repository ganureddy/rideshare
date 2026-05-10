"""Ride controller — distance/duration compute, seat sync, search blob."""

from __future__ import annotations

import frappe
from frappe.model.document import Document
from frappe.utils import add_to_date, get_datetime

from rideshare.utils.geo import LatLng, estimate_duration_minutes, haversine_km


class Ride(Document):
	def validate(self) -> None:
		self._validate_driver()
		self._validate_vehicle()
		self._compute_route_stats()
		self._sync_seats()
		self._build_search_blob()

	def before_save(self) -> None:
		if self.status == "Draft":
			return

	def _validate_driver(self) -> None:
		if not self.driver:
			return
		profile_name = frappe.db.get_value("Driver Profile", {"user": self.driver}, "name")
		if not profile_name:
			frappe.throw(
				"Driver does not have a Driver Profile yet. Complete onboarding first."
			)
		require_id = frappe.db.get_single_value(
			"Rideshare Settings", "require_id_verification"
		)
		is_verified = frappe.db.get_value("Driver Profile", profile_name, "is_verified")
		if require_id and self.status in ("Published", "InProgress", "Completed", "Full") and not is_verified:
			frappe.throw("Driver must be verified before publishing rides.")

	def _validate_vehicle(self) -> None:
		if not self.vehicle:
			return
		owner = frappe.db.get_value("Vehicle", self.vehicle, "owner_user")
		if owner != self.driver:
			frappe.throw("Vehicle does not belong to this driver.")
		seats = frappe.db.get_value("Vehicle", self.vehicle, "seats_available") or 0
		if int(self.seats_total or 0) > int(seats):
			frappe.throw(f"This vehicle has only {seats} passenger seats.")

	def _compute_route_stats(self) -> None:
		if (
			self.origin_lat is None
			or self.origin_lng is None
			or self.destination_lat is None
			or self.destination_lng is None
		):
			# Fall back to City lat/lng if explicit coords missing.
			self._fill_coords_from_city()

		try:
			a = LatLng(float(self.origin_lat or 0), float(self.origin_lng or 0))
			b = LatLng(float(self.destination_lat or 0), float(self.destination_lng or 0))
			self.distance_km = round(haversine_km(a, b), 1)
			self.duration_minutes = estimate_duration_minutes(self.distance_km)
		except Exception:
			self.distance_km = 0
			self.duration_minutes = 0

		if self.departure_datetime and self.duration_minutes:
			self.estimated_arrival = add_to_date(
				get_datetime(self.departure_datetime), minutes=int(self.duration_minutes)
			)

	def _fill_coords_from_city(self) -> None:
		if self.origin_city and (not self.origin_lat or not self.origin_lng):
			lat, lng = frappe.db.get_value("City", self.origin_city, ["lat", "lng"]) or (0, 0)
			self.origin_lat = lat or self.origin_lat
			self.origin_lng = lng or self.origin_lng
		if self.destination_city and (not self.destination_lat or not self.destination_lng):
			lat, lng = frappe.db.get_value("City", self.destination_city, ["lat", "lng"]) or (0, 0)
			self.destination_lat = lat or self.destination_lat
			self.destination_lng = lng or self.destination_lng

	def _sync_seats(self) -> None:
		"""Compute seats_available = seats_total - confirmed bookings."""

		booked = 0
		if self.name and not self.is_new():
			booked = (
				frappe.db.sql(
					"""SELECT COALESCE(SUM(seats_booked), 0)
					FROM `tabBooking`
					WHERE ride = %s AND status IN ('Confirmed', 'Completed')""",
					self.name,
				)[0][0]
				or 0
			)
		self.seats_available = max(int(self.seats_total or 0) - int(booked), 0)

		if self.status == "Published" and self.seats_available == 0:
			self.status = "Full"
		elif self.status == "Full" and self.seats_available > 0:
			self.status = "Published"

	def _build_search_blob(self) -> None:
		"""Cheap denormalised text used by FULLTEXT search in Phase 4."""

		parts = [
			self.origin_city or "",
			self.destination_city or "",
			self.origin_address or "",
			self.destination_address or "",
			self.description or "",
		]
		for w in self.waypoints or []:
			parts.append(w.city or "")
		self.search_blob = " | ".join(p for p in parts if p)
