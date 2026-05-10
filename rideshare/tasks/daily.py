"""Daily scheduled tasks for the Rideshare app."""

from __future__ import annotations

import logging

import frappe

logger = logging.getLogger(__name__)


def auto_complete_overdue_trips() -> None:
	"""Auto-complete trips whose ``estimated_arrival`` is > 48h in the past.

	Real logic lands in Phase 7.  We early-return when the Ride DocType
	is not yet installed so the scheduler doesn't error during Phase 1.
	"""

	if not frappe.db.exists("DocType", "Ride"):
		return
	logger.debug("rideshare.auto_complete_overdue_trips: deferred to Phase 7")


def cleanup_orphaned_otp_tokens() -> None:
	"""Remove expired OTP rows older than 24h.

	The ``OTP Token`` DocType is created in Phase 2; we early-return
	until then so this scheduler entry is harmless.
	"""

	if not frappe.db.exists("DocType", "OTP Token"):
		return
	logger.debug("rideshare.cleanup_orphaned_otp_tokens: deferred to Phase 2")
