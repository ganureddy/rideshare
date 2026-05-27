"""Booking controller — money split, seat sync hook, lifecycle helpers."""

from __future__ import annotations

import secrets

import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime

from rideshare.utils.money import rupees_to_paise, split_platform_fee


class Booking(Document):
	def validate(self) -> None:
		self._validate_seats()
		self._populate_amounts()
		if not self.booking_code:
			self.booking_code = "BB-" + secrets.token_hex(3).upper()
		if not self.booked_on:
			self.booked_on = now_datetime()

	def on_update(self) -> None:
		# Recompute parent ride seats whenever a booking changes.
		if self.ride:
			ride = frappe.get_doc("Ride", self.ride)
			ride.flags.ignore_validate_update_after_submit = True
			ride.save(ignore_permissions=True)

	def on_trash(self) -> None:
		if self.ride:
			ride = frappe.get_doc("Ride", self.ride)
			ride.save(ignore_permissions=True)

	def _validate_seats(self) -> None:
		if int(self.seats_booked or 0) <= 0:
			frappe.throw("At least 1 seat must be booked.")
		if not self.ride:
			return
		ride = frappe.get_doc("Ride", self.ride)
		if ride.driver == self.passenger:
			frappe.throw("Drivers cannot book their own ride.")
		if ride.status in ("Cancelled", "Completed"):
			frappe.throw(f"Ride is {ride.status}; no new bookings.")

		other_seats = (
			frappe.db.sql(
				"""SELECT COALESCE(SUM(seats_booked), 0)
				FROM `tabBooking`
				WHERE ride = %s AND name != %s
				AND status IN ('Confirmed', 'Pending', 'Completed')""",
				(self.ride, self.name or ""),
			)[0][0]
			or 0
		)
		if int(other_seats) + int(self.seats_booked or 0) > int(ride.seats_total or 0):
			frappe.throw(
				f"Only {int(ride.seats_total) - int(other_seats)} seat(s) left on this ride."
			)

	def _populate_amounts(self) -> None:
		if not self.ride:
			return
		ride = frappe.get_doc("Ride", self.ride)
		self.currency = self.currency or ride.currency or "INR"
		seat_price = float(ride.price_per_seat or 0)
		total_rupees = seat_price * int(self.seats_booked or 1)

		fee_percent = (
			frappe.db.get_single_value("Rideshare Settings", "platform_fee_percent") or 12
		)
		total_paise = rupees_to_paise(total_rupees)
		fee_paise, payout_paise = split_platform_fee(total_paise, float(fee_percent))

		self.total_amount = total_paise / 100
		self.platform_fee = fee_paise / 100
		self.driver_payout = payout_paise / 100
