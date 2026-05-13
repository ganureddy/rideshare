"""Push-token management endpoints.

The mobile app POSTs its Expo push token here once per session (or
whenever the OS issues a fresh one).  We store it against the calling
user — multiple devices per user are fine — so any subsequent
``rideshare.utils.push.notify_user`` call reaches every device.

On logout the app calls ``unregister_push_token`` so the user stops
receiving alerts on a phone they're no longer signed in on.
"""

from __future__ import annotations

import frappe
from frappe import _

from rideshare.utils.push import remove_token, upsert_token


@frappe.whitelist()
def register_push_token(
	token: str,
	platform: str = "android",
	app_version: str | None = None,
) -> dict:
	"""Persist (current_user, token) so we can push to this device.

	Idempotent on ``token``: re-registering the same value moves it onto
	the current user (handy when one phone is shared across logins).
	"""

	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	token = (token or "").strip()
	if not token:
		frappe.throw(_("Push token is required."), frappe.ValidationError)

	# Sanity check: Expo tokens always start with "ExponentPushToken[" or
	# "ExpoPushToken[".  Reject obvious garbage so the table doesn't grow
	# unbounded with bad input.
	if not (token.startswith("ExponentPushToken[") or token.startswith("ExpoPushToken[")):
		frappe.throw(_("Not a valid Expo push token."), frappe.ValidationError)

	name = upsert_token(user=user, token=token, platform=platform, app_version=app_version)
	return {"ok": True, "token_id": name}


@frappe.whitelist()
def unregister_push_token(token: str) -> dict:
	"""Remove a token — called on sign-out so we stop sending to it."""

	user = frappe.session.user
	if user == "Guest":
		return {"ok": True, "removed": False}
	# Only let the owner remove their own token.
	owner = frappe.db.get_value("User Push Token", {"token": token}, "user")
	if owner and owner != user:
		frappe.throw(_("Not your token."), frappe.PermissionError)
	removed = remove_token(token)
	return {"ok": True, "removed": removed}
