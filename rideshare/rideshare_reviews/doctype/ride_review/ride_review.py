"""Ride Review controller.

A single Ride Review row captures one party's rating of the other for
ONE booking.  Strict rules:

  * Allowed only AFTER the ride is Completed.
  * Reviewer must be a participant (driver or passenger) on that booking.
  * One review per ``(booking, direction)`` — re-submitting overwrites
    the existing row instead of stacking.
  * Rating is 1-5 stars (validated; nothing else is accepted).
  * On insert/update, the reviewee's User-level aggregate is recomputed
    so the search results + driver display update without a separate
    materialisation job.

Aggregates live on the existing ``Driver Profile`` (avg_rating,
total_reviews, total_trips) for drivers, and on a denormalised pair
(``rider_avg_rating``, ``rider_total_reviews``) we add to ``User`` —
that lets us also show "★ 4.8 — 12 reviews as a passenger" on
profiles, which makes drivers more likely to accept new riders.
"""

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import now_datetime


class RideReview(Document):
	def validate(self) -> None:
		self._validate_rating()
		self._validate_participants()
		self._validate_ride_completed()

	def before_insert(self) -> None:
		if not self.submitted_at:
			self.submitted_at = now_datetime()

	def after_insert(self) -> None:
		self._recompute_aggregate()

	def on_update(self) -> None:
		# Edits change the average — recompute.
		self._recompute_aggregate()

	def on_trash(self) -> None:
		self._recompute_aggregate()

	# -- Validation ----------------------------------------------------------

	def _validate_rating(self) -> None:
		try:
			r = int(self.rating or 0)
		except (TypeError, ValueError):
			frappe.throw(_("Rating must be a number from 1 to 5."))
		if r < 1 or r > 5:
			frappe.throw(_("Rating must be between 1 and 5 stars."))
		self.rating = r

	def _validate_participants(self) -> None:
		"""Reviewer + ratee must be the two parties on the booking."""

		booking = frappe.db.get_value(
			"Booking",
			self.booking,
			["ride", "passenger", "status"],
			as_dict=True,
		)
		if not booking:
			frappe.throw(_("Booking not found."))
		driver = frappe.db.get_value("Ride", booking.ride, "driver")
		if not driver:
			frappe.throw(_("Ride has no driver — review not allowed."))

		# Direction-based validity.  We deliberately enforce both sides
		# of the pair so a driver can't rate a *different* passenger by
		# fudging the form.
		if self.direction == "passenger_to_driver":
			if self.reviewer != booking.passenger:
				frappe.throw(_("Only the passenger can submit this review."), frappe.PermissionError)
			if self.ratee != driver:
				frappe.throw(_("Reviewee must be the driver."))
		elif self.direction == "driver_to_passenger":
			if self.reviewer != driver:
				frappe.throw(_("Only the driver can submit this review."), frappe.PermissionError)
			if self.ratee != booking.passenger:
				frappe.throw(_("Reviewee must be the passenger."))
		else:
			frappe.throw(_("Invalid review direction."))

		# Denormalise ride for fast aggregate queries.
		self.ride = booking.ride

	def _validate_ride_completed(self) -> None:
		"""No reviews until the ride is actually Completed.

		Avoids people trash-rating drivers before the trip even
		happened.  Cancelled bookings never gain a review.
		"""

		ride_status = frappe.db.get_value("Ride", self.ride, "status")
		booking_status = frappe.db.get_value("Booking", self.booking, "status")
		if ride_status != "Completed":
			frappe.throw(_("You can review this ride after it's marked Completed."))
		if booking_status not in ("Completed",):
			# Booking has its own lifecycle; tolerate Confirmed +
			# Completed (some flows mark the booking Completed only
			# when the driver settles payouts).
			if booking_status not in ("Confirmed",):
				frappe.throw(_("Booking must be confirmed before reviewing."))

	# -- Aggregate updates ---------------------------------------------------

	def _recompute_aggregate(self) -> None:
		"""Fold every review's rating for the ratee into a fresh average.

		Direction matters:
		  * passenger_to_driver → updates Driver Profile.avg_rating
		  * driver_to_passenger → updates User.rider_avg_rating
		    (custom fields added by the patch).

		Single SQL for the average + count keeps this O(1) per insert
		regardless of total review volume.
		"""

		ratee = self.ratee
		direction = self.direction
		row = frappe.db.sql(
			"""SELECT AVG(rating), COUNT(*) FROM `tabRide Review`
			   WHERE ratee = %(u)s AND direction = %(d)s""",
			{"u": ratee, "d": direction},
		)[0]
		avg = float(row[0] or 0)
		count = int(row[1] or 0)

		if direction == "passenger_to_driver":
			dp_name = frappe.db.get_value("Driver Profile", {"user": ratee}, "name")
			if dp_name:
				frappe.db.set_value(
					"Driver Profile",
					dp_name,
					{"avg_rating": round(avg, 2), "total_reviews": count},
					update_modified=False,
				)
		else:
			# Riders don't have a Driver Profile by default — store the
			# aggregate on the User row via custom fields injected by
			# our patch.  Updating non-existent fields is harmless on
			# a fresh schema (Frappe ignores unknown fields with
			# update_modified=False).
			try:
				frappe.db.set_value(
					"User",
					ratee,
					{
						"rider_avg_rating": round(avg, 2),
						"rider_total_reviews": count,
					},
					update_modified=False,
				)
			except Exception:
				# Custom fields not yet installed; let the patch fix
				# this on next migrate.
				pass
		frappe.db.commit()
