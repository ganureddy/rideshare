"""Mobile-only authentication.

The *fun* MVP rule: a user types their mobile number; if a matching User
exists they're logged in, otherwise we create one (Rider role) and log
them in.  No passwords, no OTP.

This is **not safe for production** — anyone who knows a phone number can
impersonate the owner.  For real launch, swap to OTP via MSG91 (the
provider abstraction is already in place: ``rideshare.utils.notifications``).
"""

from __future__ import annotations

import re

import frappe
from frappe import _

MOBILE_RE = re.compile(r"^\+?\d{10,15}$")
SYNTHETIC_DOMAIN = "rideshare.local"


def _normalise(mobile: str) -> str:
	mobile = (mobile or "").strip().replace(" ", "").replace("-", "")
	if not MOBILE_RE.match(mobile):
		frappe.throw(_("Enter a valid mobile number (10–15 digits)."), frappe.ValidationError)
	# Default-prefix +91 for plain Indian 10-digit numbers.
	if not mobile.startswith("+") and len(mobile) == 10:
		mobile = "+91" + mobile
	return mobile


def _user_id_for(mobile: str) -> str:
	# Stable, deterministic email built from the mobile.  Used as the
	# Frappe `User.name` (which Frappe requires to be email-like).
	digits = re.sub(r"\D", "", mobile)
	return f"{digits}@{SYNTHETIC_DOMAIN}"


@frappe.whitelist(allow_guest=True)
def login_or_signup(mobile_no: str, full_name: str | None = None) -> dict:
	"""Find-or-create a User keyed on ``mobile_no`` and start a session.

	Args:
	    mobile_no: phone number with or without ``+91`` prefix.
	    full_name: optional, used only on first-time signup.

	Returns:
	    {"user": <user_id>, "is_new": bool, "redirect_to": "/me"}
	"""

	mobile = _normalise(mobile_no)
	user_id = _user_id_for(mobile)

	is_new = not frappe.db.exists("User", user_id)
	if is_new:
		_create_user(user_id, mobile, full_name)

	# Begin a session for this user without checking a password.
	# In HTTP request context the login_manager is set up by Frappe's WSGI
	# entrypoint; in test/console context it's not available, so we fall
	# back to ``frappe.set_user``.
	try:
		frappe.local.login_manager.user = user_id
		frappe.local.login_manager.post_login()
	except (AttributeError, RuntimeError):
		frappe.set_user(user_id)

	return {
		"user": user_id,
		"mobile_no": mobile,
		"is_new": is_new,
		"redirect_to": "/me",
	}


def _create_user(user_id: str, mobile: str, full_name: str | None) -> None:
	first, last = _split_name(full_name)
	doc = frappe.get_doc(
		{
			"doctype": "User",
			"email": user_id,
			"username": user_id.split("@")[0],
			"first_name": first,
			"last_name": last,
			"mobile_no": mobile,
			"phone": mobile,
			"send_welcome_email": 0,
			"enabled": 1,
			"user_type": "Website User",
			"new_password": frappe.generate_hash(length=24),
			"roles": [{"role": "Rider"}],
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert(ignore_permissions=True)


def _split_name(full_name: str | None) -> tuple[str, str]:
	if not full_name:
		return ("Rider", "")
	parts = full_name.strip().split()
	if len(parts) == 1:
		return (parts[0], "")
	return (parts[0], " ".join(parts[1:]))


@frappe.whitelist(allow_guest=True)
def logout() -> dict:
	frappe.local.login_manager.logout()
	frappe.db.commit()
	return {"redirect_to": "/"}


@frappe.whitelist()
def whoami() -> dict:
	"""Return basic info about the currently-logged-in user (or guest)."""

	user = frappe.session.user
	if user == "Guest":
		return {"user": "Guest", "is_authenticated": False}
	doc = frappe.get_doc("User", user)
	roles = frappe.get_roles(user)
	driver_profile = frappe.db.get_value(
		"Driver Profile", {"user": user}, ["name", "is_verified", "verification_status"], as_dict=True
	)
	return {
		"user": user,
		"is_authenticated": True,
		"full_name": doc.full_name,
		"first_name": doc.first_name,
		"mobile_no": doc.mobile_no,
		"roles": roles,
		"is_driver": "Driver" in roles or "Verified Driver" in roles,
		"is_verified_driver": "Verified Driver" in roles,
		"driver_profile": driver_profile,
	}


# ---------------------------------------------------------------------------
# Mobile (React Native) — token-based auth.
#
# The web flow above starts a cookie session.  Mobile clients prefer a stable
# (api_key, api_secret) pair they can keep in OS-level secure storage and send
# as ``Authorization: token <key>:<secret>`` on every request.  Frappe accepts
# this header natively, so we just need to mint and return the pair.
#
# TODO(prod): Gate this behind OTP via MSG91 before launch.  The MVP knowingly
# trusts the phone number as the only credential — see module docstring.
# ---------------------------------------------------------------------------


def _ensure_api_keys(user_id: str) -> tuple[str, str]:
	"""Return (api_key, api_secret) for ``user_id``, generating them if absent.

	Frappe stores ``api_secret`` as a Password (encrypted at rest); we surface
	it once at login time so the device can persist it.  Subsequent logins
	from new devices rotate the secret to invalidate prior tokens.
	"""

	user = frappe.get_doc("User", user_id)
	api_secret = frappe.generate_hash(length=15)
	if not user.api_key:
		user.api_key = frappe.generate_hash(length=15)
	user.api_secret = api_secret
	user.flags.ignore_permissions = True
	user.save(ignore_permissions=True)
	frappe.db.commit()
	return user.api_key, api_secret


@frappe.whitelist(allow_guest=True)
def login_with_phone(mobile_no: str, full_name: str | None = None) -> dict:
	"""Mobile-app login: find-or-create User and return API token pair.

	The pair is sent as ``Authorization: token <api_key>:<api_secret>`` on
	every subsequent call.  The cookie session is *also* started so that any
	server-rendered surfaces (deep links into ``/rideshare/login`` etc.)
	work without re-authenticating.
	"""

	mobile = _normalise(mobile_no)
	user_id = _user_id_for(mobile)

	is_new = not frappe.db.exists("User", user_id)
	if is_new:
		_create_user(user_id, mobile, full_name)

	api_key, api_secret = _ensure_api_keys(user_id)

	try:
		frappe.local.login_manager.user = user_id
		frappe.local.login_manager.post_login()
	except (AttributeError, RuntimeError):
		frappe.set_user(user_id)

	user_doc = frappe.get_doc("User", user_id)
	roles = frappe.get_roles(user_id)
	driver_profile = frappe.db.get_value(
		"Driver Profile", {"user": user_id},
		["name", "is_verified", "verification_status"], as_dict=True
	)

	return {
		"user": user_id,
		"mobile_no": mobile,
		"is_new": is_new,
		"api_key": api_key,
		"api_secret": api_secret,
		"profile": {
			"full_name": user_doc.full_name,
			"first_name": user_doc.first_name,
			"roles": roles,
			"is_driver": "Driver" in roles or "Verified Driver" in roles,
			"is_verified_driver": "Verified Driver" in roles,
			"driver_profile": driver_profile,
		},
	}


@frappe.whitelist()
def revoke_tokens() -> dict:
	"""Rotate api_secret to invalidate all existing device tokens."""

	user_id = frappe.session.user
	if user_id == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)
	user = frappe.get_doc("User", user_id)
	user.api_secret = frappe.generate_hash(length=15)
	user.flags.ignore_permissions = True
	user.save(ignore_permissions=True)
	frappe.db.commit()
	return {"revoked": True}
