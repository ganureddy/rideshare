"""Hourly scheduled tasks.

Wired in `hooks.py`.  Each task is safe to call even before the relevant
DocTypes exist — we guard with `frappe.db.exists("DocType", ...)`.
"""

from __future__ import annotations

import logging

import frappe

logger = logging.getLogger(__name__)


def expire_pending_bookings() -> None:
	"""Auto-decline `Booking` rows that have been ``Pending`` past TTL.

	TTL is read from `Rideshare Settings.pending_booking_ttl_minutes`
	once that DocType exists (Phase 5).  Until then this is a no-op.
	"""

	if not frappe.db.exists("DocType", "Booking"):
		return

	ttl_minutes = (
		frappe.db.get_single_value("Rideshare Settings", "pending_booking_ttl_minutes") or 30
	)
	cutoff = frappe.utils.add_to_date(None, minutes=-int(ttl_minutes))

	expired = frappe.get_all(
		"Booking",
		filters={"status": "Pending", "booked_on": ["<", cutoff]},
		pluck="name",
	)
	for booking in expired:
		try:
			doc = frappe.get_doc("Booking", booking)
			doc.status = "Cancelled"
			doc.add_comment("Comment", text="Auto-cancelled: pending booking TTL expired.")
			doc.save(ignore_permissions=True)
		except Exception:
			logger.exception("rideshare.expire_pending_bookings failed for %s", booking)
	frappe.db.commit()


def release_due_escrows() -> None:
	"""Move ``Held`` payments to ``Released`` once payout delay has elapsed.

	Implemented in Phase 5; here we early-return to keep the scheduler
	registration honest.
	"""

	if not frappe.db.exists("DocType", "Payment Transaction"):
		return
	# Real implementation lands in Phase 5.
	logger.debug("rideshare.release_due_escrows: deferred to Phase 5")
