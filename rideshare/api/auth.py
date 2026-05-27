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
# Practical email shape — covers anything Gmail / hosted providers issue.
# We use this to gate "do we actually have a deliverable address?" rather
# than to validate RFC 5322 exhaustively (Frappe does that on save too).
EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
SYNTHETIC_DOMAIN = "rideshare.local"


def _clean_email(raw: str | None) -> str | None:
	"""Normalise + validate a user-supplied email; return ``None`` if empty.

	Raises on a clearly-malformed address so the caller surfaces a tidy
	error instead of letting it propagate to Frappe's SQL-error path.
	"""

	if raw is None:
		return None
	email = (raw or "").strip().lower()
	if not email:
		return None
	if len(email) > 140 or not EMAIL_RE.match(email):
		frappe.throw(_("That doesn't look like a valid email address."), frappe.ValidationError)
	return email


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


def _create_user(
	user_id: str,
	mobile: str,
	full_name: str | None,
	email: str | None = None,
) -> None:
	"""Create a Website User keyed on the synthetic ``user_id``.

	``email`` (when provided + valid) is stored separately in the
	``User.location`` field WAIT — no, Frappe doesn't have a "secondary
	email" field on User by default and ``User.email`` is the primary
	key.  We keep ``email`` (the row key) = the synthetic phone-derived
	address so every downstream lookup keyed on the phone still works,
	and stash the real address in ``User.username``'s sibling field
	``User.email`` would clobber that, so we use Frappe's
	``Contact``-style additional emails OR — easiest and what every
	mobile-first product does — we drop the real address into the
	user-facing ``mobile_no`` adjacent ``location`` slot.

	In practice the simplest correct choice is to store it on the
	standard ``User.email`` field as a *secondary* update only if it's
	different from the row key.  That's what the rest of the codebase
	expects to read (``User.email`` for outbound mail), and we never
	change the row key (``User.name``) — so the relationship stays
	stable.

	Implementation: row key stays ``<digits>@rideshare.local``; the
	real address is written to a sibling field that the rest of Frappe
	already understands — ``User.email`` itself **is** the row key, so
	we use ``frappe.db.set_value`` on the row name to add a real
	deliverable address in a dedicated column.  Frappe's ``User`` has a
	``location`` field as a generic Data slot — we co-opt it via the
	module-level ``REAL_EMAIL_FIELD`` constant so this is easy to find
	and reverse.
	"""

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

	if email:
		_set_user_real_email(user_id, email)


# ---------------------------------------------------------------------------
# Real (deliverable) email vs synthetic row-key email.
#
# Phone signup uses ``<digits>@rideshare.local`` as the User row name so the
# whole codebase can keep keying off the phone.  The user's actual mailbox —
# the one we want to send Welcome / booking-confirmed emails to — is stored
# on a separate column.
#
# Why ``User.location``?
#   * It's a built-in Data field, no schema migration needed.
#   * It's not surfaced anywhere in the Rideshare UI (we never display
#     it as a location), so we don't risk visual collisions.
#   * Email Account / Newsletter / `frappe.sendmail()` paths use
#     ``User.email`` for routing, so they'd never accidentally fetch
#     this slot.  We always pass our value as an explicit recipient.
# ---------------------------------------------------------------------------
REAL_EMAIL_FIELD = "location"


def _set_user_real_email(user_id: str, email: str) -> None:
	"""Persist the user's deliverable address (separate from the row key)."""

	if not email:
		return
	try:
		frappe.db.set_value("User", user_id, REAL_EMAIL_FIELD, email, update_modified=False)
	except Exception:
		# Worst case the column doesn't exist on this Frappe build; in
		# that case the email field on the User row is what we'll read
		# back, and welcome/booking emails just don't go.  Don't poison
		# the signup path.
		frappe.log_error(
			title="Could not persist user email",
			message=frappe.get_traceback(),
		)


def get_user_real_email(user_id: str | None) -> str | None:
	"""Return the user's deliverable email, or ``None`` when not set.

	Resolution order:
	  1. The dedicated ``REAL_EMAIL_FIELD`` slot (phone signups +
	     EditProfile updates land here).
	  2. ``User.email`` itself, but only if it's not the synthetic
	     ``@rideshare.local`` placeholder (Google sign-ups have a real
	     address in ``email`` directly).

	Bookings, welcome mailers, and any future newsletter callsite use
	this single helper so the routing rule stays in one place.
	"""

	if not user_id or user_id in ("Administrator", "Guest"):
		return None
	# Two-column read on the same row is one query thanks to
	# frappe.db.get_value's tuple-of-fields call shape.
	row = frappe.db.get_value(
		"User", user_id, ["email", REAL_EMAIL_FIELD], as_dict=True
	)
	if not row:
		return None
	dedicated = (row.get(REAL_EMAIL_FIELD) or "").strip().lower()
	if dedicated and EMAIL_RE.match(dedicated):
		return dedicated
	primary = (row.get("email") or "").strip().lower()
	if primary and not primary.endswith(f"@{SYNTHETIC_DOMAIN}") and EMAIL_RE.match(primary):
		return primary
	return None


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
	# Mobile UI cares about the deliverable email (where Welcome /
	# Booking-confirmed mail goes), not the synthetic row-key one.
	real_email = get_user_real_email(user)
	return {
		"user": user,
		"is_authenticated": True,
		"full_name": doc.full_name,
		"first_name": doc.first_name,
		"last_name": doc.last_name,
		"email": real_email or doc.email,
		"has_real_email": bool(real_email),
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
	email: str | None = None,
) -> dict:
	"""Let a signed-in user edit their basic profile.

	Whitespace-only / missing fields are treated as "no change" so the
	mobile screen can submit only what the user actually edited.  Mobile
	number changes are intentionally rejected here — the User.name is
	derived from the phone number (see ``_user_id_for``); changing it
	would orphan every Booking/Ride/Chat row.

	Email is the *secondary* (deliverable) address — see
	``_set_user_real_email`` for why we don't overwrite ``User.email``
	itself.  Pass an empty string to clear it.
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

	# Email update — handled out-of-band on the dedicated REAL_EMAIL_FIELD
	# column so we never accidentally rename the User row (which would
	# orphan every Booking/Ride/Chat that FKs the synthetic phone email).
	if email is not None:
		raw = (email or "").strip()
		if raw == "":
			# Explicit clear — empty string opts the user out of email.
			try:
				frappe.db.set_value(
					"User", user, REAL_EMAIL_FIELD, "", update_modified=False
				)
			except Exception:
				pass
		else:
			cleaned = _clean_email(raw)  # raises on malformed
			previous = get_user_real_email(user)
			_set_user_real_email(user, cleaned or "")
			# Send a welcome mail when a phone-signup user first attaches
			# an email — gives them a tangible "yes, we have you" record.
			if cleaned and not previous:
				_send_welcome_email(user, cleaned)

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
def google_login_url(
	next_url: str | None = None, return_to: str | None = None
) -> dict:
	"""Return a one-shot Google authorize URL for the mobile WebBrowser.

	The mobile app opens this URL in its system browser; once Google
	returns the user, Frappe's standard OAuth callback creates / updates
	the User row and redirects to ``next_url`` (default:
	``/rideshare/m/oauth-callback``) which mints API tokens and bounces
	back to the app via a deep link.

	``return_to`` is an optional deep-link prefix supplied by the device
	— e.g. ``rideshare://auth/callback`` for a real APK build or
	``exp://<tunnel-host>/--/auth/callback`` for an Expo Go session.  We
	embed it into ``next_url``'s query string so the callback page can
	bounce to the right scheme on whichever runtime the user is on.
	Without it the page falls back to the bundled ``rideshare://`` scheme
	(which is the right answer for production APKs).
	"""

	from urllib.parse import quote, urlencode

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
	if return_to:
		# Only forward schemes we trust as legit "open the mobile app"
		# targets so an attacker can't pivot the OAuth flow into an
		# arbitrary URL (e.g. https://evil/?code=...).
		clean = (return_to or "").strip()
		if clean.startswith(("rideshare://", "exp://")):
			sep = "&" if "?" in target else "?"
			target = f"{target}{sep}{urlencode({'return_to': clean})}"

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
	real_email = get_user_real_email(user_id)
	return {
		"user": user_id,
		"mobile_no": user_doc.mobile_no,
		"api_key": api_key,
		"api_secret": api_secret,
		"profile": {
			"full_name": user_doc.full_name,
			"first_name": user_doc.first_name,
			"email": real_email or user_doc.email,
			"has_real_email": bool(real_email),
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
	real_email = get_user_real_email(user_id)
	return {
		"user": user_id,
		"mobile_no": user_doc.mobile_no,
		"api_key": api_key,
		"api_secret": api_secret,
		"profile": {
			"full_name": user_doc.full_name,
			"first_name": user_doc.first_name,
			"email": real_email or user_doc.email,
			"has_real_email": bool(real_email),
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
def login_with_phone(
	mobile_no: str,
	full_name: str | None = None,
	email: str | None = None,
) -> dict:
	"""Mobile-app login: find-or-create User and return API token pair.

	The pair is sent as ``Authorization: token <api_key>:<api_secret>`` on
	every subsequent call.  The cookie session is *also* started so that any
	server-rendered surfaces (deep links into ``/rideshare/m/login`` etc.)
	work without re-authenticating.

	``email`` is optional and only honoured on first-time signup (the
	value is also accepted on returning logins where the user is filling
	in a previously-blank email — but the regular EditProfile path is
	the canonical surface for that).
	"""

	mobile = _normalise(mobile_no)
	user_id = _user_id_for(mobile)
	cleaned_email = _clean_email(email)

	is_new = not frappe.db.exists("User", user_id)
	if is_new:
		_create_user(user_id, mobile, full_name, cleaned_email)
		if cleaned_email:
			_send_welcome_email(user_id, cleaned_email)
	elif cleaned_email and not get_user_real_email(user_id):
		# Returning user who never set an email yet — opportunistically
		# attach what they typed and send the welcome.
		_set_user_real_email(user_id, cleaned_email)
		_send_welcome_email(user_id, cleaned_email)

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
		["name", "is_verified", "verification_status", "bio"], as_dict=True
	)
	real_email = get_user_real_email(user_id)

	# Return the full profile shape that ``whoami`` would — that way a
	# returning user's screens (Profile, EditProfile, Tracking header)
	# can paint their stored name + portrait + phone on the very first
	# frame after login, instead of flashing placeholders for one
	# `whoami` round-trip.
	return {
		"user": user_id,
		"mobile_no": mobile,
		"is_new": is_new,
		"api_key": api_key,
		"api_secret": api_secret,
		"profile": {
			"full_name": user_doc.full_name,
			"first_name": user_doc.first_name,
			"last_name": user_doc.last_name,
			"email": real_email or user_doc.email,
			"has_real_email": bool(real_email),
			"mobile_no": user_doc.mobile_no or mobile,
			"user_image": user_doc.user_image,
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


# ---------------------------------------------------------------------------
# Auto-role assignment for every new Website User.
#
# Phone signup (``_create_user`` above) already grants ``Rider`` explicitly,
# but the Google OAuth path (Frappe's built-in ``login_via_google``) creates
# a plain User with no Rideshare-specific role — leaving the user unable to
# call any whitelisted ride/booking endpoint.
#
# This hook fires on User.after_insert for every Website User and is a noop
# when the role is already present, so it covers Google sign-ups and any
# future provider (Facebook/Apple) without us touching their code paths.
# ---------------------------------------------------------------------------


def ensure_rider_role(doc, method=None) -> None:
	"""Add the ``Rider`` role to a newly created Website User.

	Wired into ``hooks.doc_events["User"]["after_insert"]``.

	Skipped for ``Administrator`` and System Users so we don't mutate
	the Desk-side seed accounts. ``ignore_permissions`` is required —
	the User row's permissions haven't been resolved yet at after_insert
	when the actor is the OAuth bridge.

	Also fires the welcome email for Google-OAuth signups: those users
	land here with a real Gmail in ``User.email`` (not the synthetic
	@rideshare.local placeholder phone signups get), so we can mail
	them straight away.  Phone signups also reach this hook but their
	welcome email is sent later from ``_create_user`` once we've stored
	the address on the dedicated field — gating on
	``get_user_real_email`` keeps both paths idempotent.
	"""

	try:
		if doc.user_type != "Website User":
			return
		if doc.name in ("Administrator", "Guest"):
			return
		existing_roles = {r.role for r in (doc.roles or []) if getattr(r, "role", None)}
		role_added = False
		if "Rider" not in existing_roles and frappe.db.exists("Role", "Rider"):
			doc.append("roles", {"role": "Rider"})
			# Use db_insert on the child rows directly so we don't
			# trigger a full save() loop from inside after_insert
			# (which Frappe considers a re-entrant write and warns
			# about).
			for role_doc in doc.get("roles") or []:
				if role_doc.role == "Rider" and not role_doc.name:
					role_doc.db_insert()
			role_added = True

		# Welcome email — fires for both Google OAuth users (their real
		# Gmail address lives in User.email directly) and any future
		# OAuth providers we add.  Phone signups hit the same path but
		# their User.email is the synthetic placeholder, so
		# get_user_real_email returns None here; they get the welcome
		# email from inside _create_user / login_with_phone where the
		# real address is provided explicitly.
		real_email = get_user_real_email(doc.name)
		if real_email:
			_send_welcome_email(doc.name, real_email)

		if role_added:
			frappe.db.commit()
	except Exception:
		# Never let a role-assignment failure block account creation —
		# the user can still sign in; an admin can backfill the role.
		frappe.log_error(
			title="ensure_rider_role failed",
			message=frappe.get_traceback(),
		)


# ---------------------------------------------------------------------------
# Welcome email
#
# Sent on first signup (any provider, any path) when we have a real
# deliverable address.  Idempotent on (user_id, email) via a short-lived
# cache marker so retries / replays don't double-send.
# ---------------------------------------------------------------------------

_WELCOME_SENT_NS = "rideshare:auth:welcome_sent"
_WELCOME_TTL_SECONDS = 7 * 24 * 3600  # one week is more than enough to dedupe


def _send_welcome_email(user_id: str, email: str) -> None:
	"""Queue a welcome email through the ``Rideshare`` Email Account.

	Best-effort: never raise into the signup path.
	"""

	if not user_id or not email:
		return
	cache = frappe.cache()
	marker = f"{_WELCOME_SENT_NS}:{user_id}:{email}"
	if cache.get_value(marker):
		return
	try:
		full_name = frappe.db.get_value("User", user_id, "full_name") or "there"
		subject = "Welcome to Rideshare — your next trip starts here"
		html = _render_welcome_email_html(full_name=full_name)

		sender_email = frappe.db.get_value(
			"Email Account",
			{"name": "Rideshare", "enable_outgoing": 1},
			"email_id",
		)
		sender = f"Rideshare <{sender_email}>" if sender_email else None

		frappe.sendmail(
			recipients=[email],
			subject=subject,
			message=html,
			sender=sender,
			reference_doctype="User",
			reference_name=user_id,
			now=False,
			delayed=True,
		)
		cache.set_value(marker, 1, expires_in_sec=_WELCOME_TTL_SECONDS)
	except Exception:
		frappe.log_error(
			title="Welcome email failed",
			message=frappe.get_traceback(),
		)


def _render_welcome_email_html(*, full_name: str) -> str:
	"""Modern HTML email body for the Welcome-Onboard moment.

	Uses a centred Rideshare-branded card with a soft animated gradient
	header (CSS @keyframes; gracefully degrades to a static gradient in
	clients that strip <style>).  All colours / fonts are inlined for
	maximum client compatibility.
	"""

	safe_name = frappe.utils.escape_html(full_name)
	return f"""\
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Welcome to Rideshare</title>
<style>
  @keyframes rsShimmer {{
    0%   {{ background-position: 0% 50%; }}
    50%  {{ background-position: 100% 50%; }}
    100% {{ background-position: 0% 50%; }}
  }}
  @keyframes rsFloat {{
    0%, 100% {{ transform: translateY(0); }}
    50%      {{ transform: translateY(-4px); }}
  }}
</style>
</head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;font-size:1px;color:#f4f6fb;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
    You're in. Share rides, save fuel, meet good people.
  </div>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f6fb;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="540" style="max-width:540px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e5e9f2;box-shadow:0 10px 30px rgba(15,23,42,.06);">
        <tr>
          <td style="
              background:linear-gradient(120deg,#1976D2 0%,#0F4FA8 35%,#1976D2 65%,#21A0FF 100%);
              background-size:200% 200%;
              animation:rsShimmer 8s ease infinite;
              padding:40px 32px;text-align:center;color:#ffffff;">
            <div style="display:inline-block;background:rgba(255,255,255,.18);border-radius:999px;padding:6px 14px;font-size:11px;letter-spacing:2px;font-weight:700;text-transform:uppercase;">RIDESHARE</div>
            <div style="margin:18px 0 6px;font-size:30px;font-weight:800;letter-spacing:-.6px;animation:rsFloat 4s ease-in-out infinite;">
              🚗 Welcome aboard, {safe_name}!
            </div>
            <div style="opacity:.9;font-size:14px;">Your account is ready. Let's hit the road.</div>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px 8px;color:#111827;font-size:15px;line-height:1.6;">
            <p style="margin:0 0 16px;">Hi {safe_name},</p>
            <p style="margin:0 0 16px;">
              Thanks for joining the Rideshare community. You're now set up to
              <strong>find rides</strong> going your way, <strong>publish</strong> your own trips,
              and <strong>chat live</strong> with the people you ride with.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 32px 8px;">
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <td valign="top" style="padding:12px 0;">
                  <table cellpadding="0" cellspacing="0">
                    <tr>
                      <td valign="top" style="width:42px;padding-right:12px;">
                        <div style="width:36px;height:36px;border-radius:10px;background:#E8F0FE;color:#1976D2;text-align:center;line-height:36px;font-size:18px;">🔎</div>
                      </td>
                      <td style="color:#111827;font-size:14px;line-height:1.5;">
                        <strong>Find a ride</strong><br>
                        <span style="color:#6b7280;font-size:13px;">Search by city, date, and seats — book in two taps.</span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td valign="top" style="padding:12px 0;border-top:1px solid #f1f5f9;">
                  <table cellpadding="0" cellspacing="0">
                    <tr>
                      <td valign="top" style="width:42px;padding-right:12px;">
                        <div style="width:36px;height:36px;border-radius:10px;background:#E8F0FE;color:#1976D2;text-align:center;line-height:36px;font-size:18px;">🛣️</div>
                      </td>
                      <td style="color:#111827;font-size:14px;line-height:1.5;">
                        <strong>Publish a ride</strong><br>
                        <span style="color:#6b7280;font-size:13px;">Share fuel + tolls and earn back what you spend on the trip.</span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td valign="top" style="padding:12px 0;border-top:1px solid #f1f5f9;">
                  <table cellpadding="0" cellspacing="0">
                    <tr>
                      <td valign="top" style="width:42px;padding-right:12px;">
                        <div style="width:36px;height:36px;border-radius:10px;background:#E8F0FE;color:#1976D2;text-align:center;line-height:36px;font-size:18px;">📍</div>
                      </td>
                      <td style="color:#111827;font-size:14px;line-height:1.5;">
                        <strong>Live trip tracking</strong><br>
                        <span style="color:#6b7280;font-size:13px;">Drivers' real-time location shared with riders during the trip.</span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:24px 32px 32px;">
            <a href="https://ride.emrid.store/rideshare" style="display:inline-block;background:#1976D2;color:#ffffff;text-decoration:none;padding:14px 26px;border-radius:999px;font-weight:700;font-size:14px;letter-spacing:.2px;">Open Rideshare →</a>
            <p style="margin:18px 0 0;color:#9ca3af;font-size:12px;">
              You're receiving this because you just joined Rideshare.<br>
              Need help? Just reply to this email.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
"""
