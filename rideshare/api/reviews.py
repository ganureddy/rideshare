"""Reviews API.

Three endpoints, all whitelisted + permission-guarded:

  * ``submit_review(booking, rating, comment, tags)`` — write or
    overwrite the caller's review for the booking.  Direction is
    inferred from the caller's role on the booking.
  * ``list_reviews(user, direction, limit=20, offset=0)`` —
    paginated list of reviews about ``user``.
  * ``pending_reviews()`` — bookings the caller can review but
    hasn't yet — used to surface a "Rate your ride" prompt on the
    Trips screen.
"""

from __future__ import annotations

from typing import Any

import frappe
from frappe import _


def _user() -> str:
	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)
	return user


def _direction_for(booking: str, user: str) -> tuple[str, str]:
	"""Return (direction, ratee) for ``user`` on this booking."""

	row = frappe.db.get_value(
		"Booking",
		booking,
		["ride", "passenger"],
		as_dict=True,
	)
	if not row:
		frappe.throw(_("Booking not found."))
	driver = frappe.db.get_value("Ride", row.ride, "driver")
	if not driver:
		frappe.throw(_("Ride has no driver."))
	if user == row.passenger:
		return "passenger_to_driver", driver
	if user == driver:
		return "driver_to_passenger", row.passenger
	frappe.throw(_("You're not a participant on this booking."), frappe.PermissionError)


@frappe.whitelist()
def submit_review(
	booking: str,
	rating: int,
	comment: str | None = None,
	tags: str | None = None,
) -> dict:
	"""Submit (or overwrite) the caller's review for ``booking``."""

	user = _user()
	direction, ratee = _direction_for(booking, user)

	# One review per (booking, direction) — fetch + update if it exists,
	# create otherwise.
	existing = frappe.db.get_value(
		"Ride Review",
		{"booking": booking, "direction": direction, "reviewer": user},
		"name",
	)
	if existing:
		doc = frappe.get_doc("Ride Review", existing)
		doc.rating = int(rating)
		doc.comment = (comment or "").strip()[:2000]
		doc.tags = (tags or "").strip()[:240]
		doc.flags.ignore_permissions = True
		doc.save(ignore_permissions=True)
	else:
		doc = frappe.new_doc("Ride Review")
		doc.booking = booking
		doc.reviewer = user
		doc.ratee = ratee
		doc.direction = direction
		doc.rating = int(rating)
		doc.comment = (comment or "").strip()[:2000]
		doc.tags = (tags or "").strip()[:240]
		doc.flags.ignore_permissions = True
		doc.insert(ignore_permissions=True)

	frappe.db.commit()
	return {
		"name": doc.name,
		"booking": booking,
		"direction": direction,
		"rating": doc.rating,
		"submitted_at": doc.submitted_at.isoformat() if doc.submitted_at else None,
	}


@frappe.whitelist(allow_guest=True)
def list_reviews(
	user: str,
	direction: str = "passenger_to_driver",
	limit: int = 20,
	offset: int = 0,
) -> dict[str, Any]:
	"""Public list of reviews about ``user`` for the given direction.

	Used on the driver detail page (and later, the public driver
	profile URL) to render social proof.
	"""

	if direction not in ("passenger_to_driver", "driver_to_passenger"):
		frappe.throw(_("Invalid direction."))
	limit = max(1, min(int(limit or 20), 100))
	offset = max(0, int(offset or 0))

	rows = frappe.db.sql(
		"""SELECT r.name, r.booking, r.rating, r.comment, r.tags,
		          r.submitted_at, r.reviewer,
		          u.full_name AS reviewer_name, u.user_image AS reviewer_image
		   FROM `tabRide Review` r
		   LEFT JOIN `tabUser` u ON u.name = r.reviewer
		   WHERE r.ratee = %(u)s AND r.direction = %(d)s
		   ORDER BY r.submitted_at DESC
		   LIMIT %(limit)s OFFSET %(offset)s""",
		{"u": user, "d": direction, "limit": limit, "offset": offset},
		as_dict=True,
	)

	# Aggregate from the live data — cheaper than joining and consistent
	# with what the DriverProfile / User aggregate stores.
	agg = frappe.db.sql(
		"""SELECT AVG(rating), COUNT(*) FROM `tabRide Review`
		   WHERE ratee = %(u)s AND direction = %(d)s""",
		{"u": user, "d": direction},
	)[0]
	avg = round(float(agg[0] or 0), 2)
	total = int(agg[1] or 0)

	return {
		"reviews": rows,
		"avg_rating": avg,
		"total": total,
		"limit": limit,
		"offset": offset,
	}


@frappe.whitelist()
def pending_reviews(limit: int = 10) -> list[dict]:
	"""Return bookings the caller can review but hasn't yet.

	A booking is reviewable when:
	  * its ride is Completed, AND
	  * the caller is either the driver or the passenger, AND
	  * no Ride Review exists for (booking, direction=caller's side).
	"""

	user = _user()
	limit = max(1, min(int(limit or 10), 50))

	# One UNION-style fetch covers both directions.
	rows = frappe.db.sql(
		"""
		(
		  SELECT b.name AS booking, b.ride, b.seats_booked,
		         r.origin_city, r.destination_city, r.departure_datetime, r.driver,
		         'passenger_to_driver' AS direction,
		         r.driver AS ratee
		  FROM `tabBooking` b
		  JOIN `tabRide` r ON r.name = b.ride
		  WHERE b.passenger = %(u)s
		    AND r.status = 'Completed'
		    AND b.status IN ('Confirmed', 'Completed')
		    AND NOT EXISTS (
		      SELECT 1 FROM `tabRide Review` rr
		      WHERE rr.booking = b.name
		        AND rr.direction = 'passenger_to_driver'
		        AND rr.reviewer = %(u)s
		    )
		)
		UNION ALL
		(
		  SELECT b.name AS booking, b.ride, b.seats_booked,
		         r.origin_city, r.destination_city, r.departure_datetime, r.driver,
		         'driver_to_passenger' AS direction,
		         b.passenger AS ratee
		  FROM `tabBooking` b
		  JOIN `tabRide` r ON r.name = b.ride
		  WHERE r.driver = %(u)s
		    AND r.status = 'Completed'
		    AND b.status IN ('Confirmed', 'Completed')
		    AND NOT EXISTS (
		      SELECT 1 FROM `tabRide Review` rr
		      WHERE rr.booking = b.name
		        AND rr.direction = 'driver_to_passenger'
		        AND rr.reviewer = %(u)s
		    )
		)
		ORDER BY departure_datetime DESC
		LIMIT %(limit)s
		""",
		{"u": user, "limit": limit},
		as_dict=True,
	)

	# Hydrate ratee display names.
	user_ids = list({r["ratee"] for r in rows if r.get("ratee")})
	if user_ids:
		meta = {
			u["name"]: u.get("full_name") or u["name"]
			for u in frappe.db.get_all(
				"User",
				filters={"name": ["in", user_ids]},
				fields=["name", "full_name"],
			)
		}
	else:
		meta = {}
	for r in rows:
		r["ratee_name"] = meta.get(r["ratee"]) or r["ratee"]
	return rows
