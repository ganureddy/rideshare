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
from frappe.rate_limiter import rate_limit

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
		"Driver Profile",
		{"user": user},
		["name", "is_verified", "verification_status", "bio"],
		as_dict=True,
	)
	return {
		"user": user,
		"is_authenticated": True,
		"full_name": doc.full_name,
		"first_name": doc.first_name,
		"last_name": doc.last_name,
		"email": doc.email,
		"mobile_no": doc.mobile_no,
		"user_image": doc.user_image,
		"roles": roles,
		"is_driver": "Driver" in roles or "Verified Driver" in roles,
		"is_verified_driver": "Verified Driver" in roles,
		"driver_profile": driver_profile,
	}


@frappe.whitelist(allow_guest=True)
@rate_limit(limit=20, seconds=60)
def check_phone(mobile_no: str) -> dict:
	"""Check whether a User exists for ``mobile_no``.

	Used by the mobile login screen to decide whether to show the
	full-name field on the next step (only required for first-time sign
	ups).  We deliberately don't reveal the user's stored name — only the
	boolean, plus a hint at how the account was originally created so the
	app can show "Continue with Google" instead of asking for a name when
	the existing account is OAuth-only.

	Rate-limited to 20 lookups / IP / minute to make phone-number
	enumeration impractical (Indian mobile space is 10 digits — at 20
	lookups/min an attacker would need ~10^4 minutes just to map a
	single digit prefix).
	"""

	mobile = _normalise(mobile_no)
	user_id = _user_id_for(mobile)
	exists = bool(frappe.db.exists("User", user_id))
	hint = None
	if exists:
		# If the user has any social login row, suggest the OAuth path on
		# next sign-in; otherwise it's a phone-only account.
		hint = frappe.db.get_value(
			"User Social Login", {"parent": user_id}, "provider"
		)
	return {"mobile_no": mobile, "exists": exists, "social_provider": hint}


@frappe.whitelist()
def update_profile(
	full_name: str | None = None,
	bio: str | None = None,
	user_image: str | None = None,
	mobile_no: str | None = None,
) -> dict:
	"""Let a signed-in user edit their basic profile.

	Whitespace-only / missing fields are treated as "no change" so the
	mobile screen can submit only what the user actually edited.  Mobile
	number changes are intentionally rejected here — the User.name is
	derived from the phone number (see ``_user_id_for``); changing it
	would orphan every Booking/Ride/Chat row.
	"""

	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	doc = frappe.get_doc("User", user)
	if mobile_no and (mobile_no.strip()) and _normalise(mobile_no) != (doc.mobile_no or ""):
		frappe.throw(
			_(
				"Phone number can't be changed from the app — your account is "
				"keyed on it.  Contact support to migrate."
			)
		)

	if full_name and full_name.strip():
		# Cap absurdly long names to keep downstream rendering predictable.
		full_name = full_name.strip()[:120]
		first, last = _split_name(full_name)
		doc.first_name = first
		doc.last_name = last
		doc.full_name = full_name

	if user_image is not None:
		raw = (user_image or "").strip()
		if not raw:
			doc.user_image = None
		elif raw.startswith(("/files/", "/private/files/")) or raw.startswith(
			("http://", "https://")
		):
			doc.user_image = raw[:500]
		else:
			# Reject anything that isn't a known-safe URL shape — guards
			# against javascript:/data: tricks ending up in the User row.
			frappe.throw(_("Invalid profile image URL."), frappe.ValidationError)

	doc.flags.ignore_permissions = True
	doc.save(ignore_permissions=True)

	# Mirror display-name + bio onto Driver Profile when one exists.
	dp_name = frappe.db.get_value("Driver Profile", {"user": user}, "name")
	if dp_name and (full_name or bio is not None):
		dp = frappe.get_doc("Driver Profile", dp_name)
		if full_name:
			dp.full_name = full_name
		if bio is not None:
			dp.bio = (bio or "").strip() or None
		dp.flags.ignore_permissions = True
		dp.save(ignore_permissions=True)

	frappe.db.commit()
	return whoami()


# ---------------------------------------------------------------------------
# Social login bridge (Google via Frappe's built-in Social Login Key)
# ---------------------------------------------------------------------------


@frappe.whitelist(allow_guest=True)
def google_login_url(next_url: str | None = None) -> dict:
	"""Return a one-shot Google authorize URL for the mobile WebBrowser.

	The mobile app opens this URL in its system browser; once Google
	returns the user, Frappe's standard OAuth callback creates / updates
	the User row and redirects to ``next_url``.  We default
	``next_url`` to the mobile callback page (``/rideshare/m/oauth-callback``)
	which mints API tokens and bounces back to the app via a deep link.
	"""

	from frappe.utils.oauth import get_oauth2_authorize_url, get_oauth_keys

	provider = "google"
	if not frappe.db.exists("Social Login Key", provider):
		frappe.throw(
			_(
				"Google Social Login isn't configured on this site. Ask the "
				"admin to add credentials in Social Login Key."
			)
		)
	if not get_oauth_keys(provider):
		frappe.throw(_("Google Social Login keys are missing or disabled."))

	target = next_url or "/rideshare/m/oauth-callback"
	return {
		"provider": provider,
		"authorize_url": get_oauth2_authorize_url(provider, target),
		"redirect_to": target,
	}


@frappe.whitelist()
def issue_mobile_tokens() -> dict:
	"""Issue fresh API key / secret for the current session user.

	Used by the OAuth-callback page so the device picks up a token pair
	without needing to re-authenticate via phone.
	"""

	user_id = frappe.session.user
	if user_id == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	api_key, api_secret = _ensure_api_keys(user_id)
	user_doc = frappe.get_doc("User", user_id)
	roles = frappe.get_roles(user_id)
	driver_profile = frappe.db.get_value(
		"Driver Profile",
		{"user": user_id},
		["name", "is_verified", "verification_status"],
		as_dict=True,
	)
	return {
		"user": user_id,
		"mobile_no": user_doc.mobile_no,
		"api_key": api_key,
		"api_secret": api_secret,
		"profile": {
			"full_name": user_doc.full_name,
			"first_name": user_doc.first_name,
			"user_image": user_doc.user_image,
			"roles": roles,
			"is_driver": "Driver" in roles or "Verified Driver" in roles,
			"is_verified_driver": "Verified Driver" in roles,
			"driver_profile": driver_profile,
		},
	}


# ---------------------------------------------------------------------------
# Mobile auth exchange codes — one-shot tokens that wrap a credential
# pair so we never put the raw api_key/secret in deep-links or page URLs.
#
# Flow:
#   1. Caller mints a code via :func:`mint_mobile_exchange_code` (when
#      authenticated, e.g. inside the OAuth callback page or as part of
#      a chat-WebView bootstrap call).
#   2. The code (a 64-char hex blob) is stored in Frappe's cache for
#      :data:`_EXCHANGE_TTL_SECONDS` seconds, mapped to the credential
#      pair we want to hand back.
#   3. Recipient redeems the code via :func:`exchange_mobile_token`,
#      which deletes it on first use and returns the tokens + profile.
# ---------------------------------------------------------------------------

_EXCHANGE_NS = "rideshare:auth:exchange"
_EXCHANGE_TTL_SECONDS = 60   # one minute is plenty for a same-process bounce


def mint_mobile_exchange_code(user_id: str | None = None) -> str:
	"""Mint a one-shot auth exchange code for ``user_id``.

	Defaults to ``frappe.session.user`` when called from a hot request.
	"""

	import secrets

	uid = user_id or frappe.session.user
	if not uid or uid == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	api_key, api_secret = _ensure_api_keys(uid)
	code = secrets.token_hex(32)
	frappe.cache().set_value(
		f"{_EXCHANGE_NS}:{code}",
		frappe.as_json({"user": uid, "api_key": api_key, "api_secret": api_secret}),
		expires_in_sec=_EXCHANGE_TTL_SECONDS,
	)
	return code


@frappe.whitelist(allow_guest=True)
def exchange_mobile_token(code: str) -> dict:
	"""Trade a one-shot exchange code for the (api_key, api_secret) pair.

	The code is deleted from cache immediately after a successful read so
	a leaked URL can't be replayed.  Returns the user + profile shape
	the React Native AuthContext expects from ``signInWithGoogle``.
	"""

	code = (code or "").strip()
	if not code or len(code) > 128:
		frappe.throw(_("Invalid exchange code."), frappe.ValidationError)

	cache = frappe.cache()
	key = f"{_EXCHANGE_NS}:{code}"
	raw = cache.get_value(key)
	if not raw:
		frappe.throw(
			_("This sign-in link has expired or already been used. Please try again."),
			frappe.AuthenticationError,
		)
	# Single-use: delete the code before doing any heavy lifting so two
	# concurrent redemptions can't both succeed.
	try:
		cache.delete_value(key)
	except Exception:
		pass

	try:
		data = frappe.parse_json(raw)
	except Exception:
		frappe.throw(_("Sign-in link is malformed."), frappe.ValidationError)

	user_id = data.get("user")
	api_key = data.get("api_key")
	api_secret = data.get("api_secret")
	if not (user_id and api_key and api_secret):
		frappe.throw(_("Sign-in link is incomplete."), frappe.ValidationError)
	if not frappe.db.exists("User", user_id):
		frappe.throw(_("User no longer exists."), frappe.AuthenticationError)

	user_doc = frappe.get_doc("User", user_id)
	roles = frappe.get_roles(user_id)
	driver_profile = frappe.db.get_value(
		"Driver Profile",
		{"user": user_id},
		["name", "is_verified", "verification_status"],
		as_dict=True,
	)
	return {
		"user": user_id,
		"mobile_no": user_doc.mobile_no,
		"api_key": api_key,
		"api_secret": api_secret,
		"profile": {
			"full_name": user_doc.full_name,
			"first_name": user_doc.first_name,
			"user_image": user_doc.user_image,
			"roles": roles,
			"is_driver": "Driver" in roles or "Verified Driver" in roles,
			"is_verified_driver": "Verified Driver" in roles,
			"driver_profile": driver_profile,
		},
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
@rate_limit(limit=10, seconds=60)
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
