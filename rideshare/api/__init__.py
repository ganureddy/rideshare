"""Whitelisted HTTP endpoints for the Rideshare app.

Sub-modules group endpoints by domain and are added per phase:
- ``onboarding`` (Phase 2): OTP, signup, driver verification.
- ``rides`` (Phase 3): publish-ride wizard backend.
- ``search`` (Phase 4): public ride search + filters.
- ``bookings`` (Phase 5): create / cancel / view bookings.
- ``payments`` (Phase 5): Razorpay order + webhook.
- ``messaging`` (Phase 6): chat threads.
- ``trips`` (Phase 7): start / complete / dispute lifecycle.
- ``reviews`` (Phase 8): mutual review submission.
- ``permissions``: row-level access helpers used in `hooks.py`.

Every public method MUST be ``@frappe.whitelist`` and explicitly declare
``allow_guest`` only where Phase brief permits (search, public ride view,
public driver profile).
"""

from __future__ import annotations

import frappe


@frappe.whitelist(allow_guest=True)
def ping() -> dict[str, str]:
	"""Liveness probe used by deploy scripts and the FrappeUI bootstrap."""

	return {"app": "rideshare", "status": "ok", "version": _app_version()}


def _app_version() -> str:
	from rideshare import __version__

	return __version__
