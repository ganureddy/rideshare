"""Fine-grained cron tasks (sub-hourly cadence)."""

from __future__ import annotations

import logging

import frappe

logger = logging.getLogger(__name__)


def refresh_ride_search_cache() -> None:
	"""Pre-warm the search cache for popular city pairs.

	Implemented in Phase 4.  Until the Ride DocType exists this is a
	deliberate no-op so the cron registration remains valid.
	"""

	if not frappe.db.exists("DocType", "Ride"):
		return
	logger.debug("rideshare.refresh_ride_search_cache: deferred to Phase 4")
