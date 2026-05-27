"""Online / offline presence for the chat layer.
======================================================================

Modelled on Raven's ``user_availability`` module — the same pattern
Slack/Discord/WhatsApp use:

  * Each authenticated user keeps a TTL'd marker in Redis.
  * The marker is refreshed by an explicit ``ping_presence`` call from
    the device (typically every 30 s while a chat screen is open) and
    on every authenticated REST call via the ``before_request`` hook.
  * When the marker is set or cleared, a ``rideshare:user_active``
    realtime event is published so other users' chat headers can flip
    "online ↔ last seen X minutes ago" without polling.

Why a separate module from Raven's?
-----------------------------------
We don't depend on Raven being installed — and even if Raven *is*
installed on the same site, its presence cache is keyed on Raven user
IDs, not Frappe ``User.name`` values.  Keeping our own cache namespace
(``rideshare:presence:<user_id>``) means our chat layer is correct
regardless of whether Raven is present.

Cache shape
-----------
::

  Key:    rideshare:presence:<user_id>
  Value:  ISO-formatted "last seen at" timestamp.
  TTL:    PRESENCE_TTL_SECONDS (default 90 s).

  Online ⇔ key exists.
  Last-seen ⇔ value of the key (when it expired) — we mirror it into
  ``User.last_active`` (a custom field is not required; we use the
  built-in ``last_active`` which Frappe already maintains for ERP
  Desk users) so we can compute "last seen 12 minutes ago" even
  after the cache has cleared.
"""

from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import now_datetime, time_diff_in_seconds

PRESENCE_NS = "rideshare:presence"
PRESENCE_TTL_SECONDS = 90  # how long after the last ping a user counts as "online"


def _key(user_id: str) -> str:
	return f"{PRESENCE_NS}:{user_id}"


def set_user_active(user_id: str | None = None) -> None:
	"""Mark a user as online for the next PRESENCE_TTL_SECONDS.

	Idempotent — repeated calls just refresh the TTL.  Broadcasts a
	``rideshare:user_active`` realtime event so the user's chat
	counterparties can update their header live, but only on the first
	transition (when the cache key wasn't already set) to avoid
	flooding the bus with redundant pings.
	"""

	user_id = user_id or frappe.session.user
	if not user_id or user_id == "Guest":
		return

	cache = frappe.cache()
	was_online = bool(cache.get_value(_key(user_id)))
	cache.set_value(
		_key(user_id),
		now_datetime().isoformat(),
		expires_in_sec=PRESENCE_TTL_SECONDS,
	)
	# Mirror to User.last_active so we still have a "last seen" time
	# after the cache key expires.  Best-effort; some sites disable
	# write-on-every-request — that's fine, the cache is the source of
	# truth while online.
	try:
		frappe.db.set_value("User", user_id, "last_active", now_datetime(), update_modified=False)
	except Exception:
		pass

	if not was_online:
		_publish_state(user_id, active=True)


def set_user_inactive(user_id: str | None = None) -> None:
	"""Explicit "go offline" — fired on logout or app-background events."""

	user_id = user_id or frappe.session.user
	if not user_id or user_id == "Guest":
		return
	cache = frappe.cache()
	was_online = bool(cache.get_value(_key(user_id)))
	cache.delete_value(_key(user_id))
	if was_online:
		_publish_state(user_id, active=False)


def is_user_active(user_id: str) -> bool:
	if not user_id or user_id == "Guest":
		return False
	return bool(frappe.cache().get_value(_key(user_id)))


def get_last_seen(user_id: str) -> str | None:
	"""Return the user's last-seen ISO timestamp.

	Order of resolution:
	  1. The live cache value (most accurate while online).
	  2. The persisted ``User.last_active`` (covers post-expiry).
	"""

	if not user_id or user_id == "Guest":
		return None
	cached = frappe.cache().get_value(_key(user_id))
	if cached:
		return cached.decode("utf-8") if isinstance(cached, (bytes, bytearray)) else str(cached)
	last_active = frappe.db.get_value("User", user_id, "last_active")
	return last_active.isoformat() if last_active else None


def _publish_state(user_id: str, active: bool) -> None:
	"""Broadcast a presence state change.

	Targets:
	  * The user themselves (so they see their own state in tabs).
	  * Anyone they share a Chat Thread with (driver/passenger).

	We deliberately avoid a global broadcast — there's no benefit to
	telling every device on the platform that a single user came
	online, and it would scale poorly past a few thousand concurrent
	users.
	"""

	payload = {"user": user_id, "active": active, "at": now_datetime().isoformat()}

	# Targeted user-to-user delivery — chat counterparties only.
	try:
		counterparties = frappe.db.sql(
			"""SELECT DISTINCT
			       CASE WHEN driver = %(u)s THEN passenger
			            WHEN passenger = %(u)s THEN driver
			       END AS other
			   FROM `tabChat Thread`
			   WHERE driver = %(u)s OR passenger = %(u)s""",
			{"u": user_id},
		)
		seen: set[str] = set()
		for (other,) in counterparties:
			if not other or other in seen:
				continue
			seen.add(other)
			frappe.publish_realtime(
				event="rideshare:user_active",
				message=payload,
				user=other,
				after_commit=False,
			)
	except Exception:
		# Don't let a presence-broadcast failure poison the request.
		frappe.log_error(
			title="Presence broadcast failed",
			message=frappe.get_traceback(),
		)


# ---------------------------------------------------------------------------
# Public REST endpoints used by the mobile app.
# ---------------------------------------------------------------------------


@frappe.whitelist()
def ping_presence() -> dict:
	"""Refresh the caller's online marker.

	The mobile chat screen calls this on mount and every 30 s while
	the screen is open.  The hook ``before_request`` also calls it on
	every authenticated REST request as a passive heartbeat.
	"""

	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)
	set_user_active(user)
	return {"ok": True, "ttl_seconds": PRESENCE_TTL_SECONDS}


@frappe.whitelist()
def go_offline() -> dict:
	"""Explicit "I'm leaving the chat" — fired on app background / logout."""

	user = frappe.session.user
	if user == "Guest":
		return {"ok": True}
	set_user_inactive(user)
	return {"ok": True}


@frappe.whitelist()
def get_presence(user_ids: str | list[str] | None = None) -> dict:
	"""Return ``{user_id: {active, last_seen}}`` for a list of user IDs.

	Accepts the user IDs as a comma-separated string OR as a JSON list
	to keep both REST and JS callers happy.
	"""

	if isinstance(user_ids, str):
		try:
			ids = frappe.parse_json(user_ids)
			if isinstance(ids, str):
				ids = [u.strip() for u in user_ids.split(",") if u.strip()]
		except Exception:
			ids = [u.strip() for u in user_ids.split(",") if u.strip()]
	else:
		ids = list(user_ids or [])

	out: dict[str, dict] = {}
	for u in ids:
		if not u:
			continue
		out[u] = {
			"active": is_user_active(u),
			"last_seen": get_last_seen(u),
		}
	return out


# ---------------------------------------------------------------------------
# Hooks — wire these into hooks.py so every authenticated request is a
# passive heartbeat.
# ---------------------------------------------------------------------------


def on_login(login_manager) -> None:  # noqa: ARG001 — required hook signature
	"""Called by Frappe on successful login (any auth mode)."""

	set_user_active()


def on_logout(login_manager) -> None:  # noqa: ARG001
	"""Called by Frappe on logout."""

	set_user_inactive()


def passive_heartbeat() -> None:
	"""``before_request`` hook — refreshes presence on every API call.

	Cheap (single Redis ``SET ... EX``).  Skipped for guest sessions
	and for unauthenticated routes.
	"""

	try:
		if frappe.session and frappe.session.user and frappe.session.user != "Guest":
			# Don't re-broadcast on every single request — only refresh
			# the TTL.  Bypass the broadcast path by setting directly.
			frappe.cache().set_value(
				_key(frappe.session.user),
				now_datetime().isoformat(),
				expires_in_sec=PRESENCE_TTL_SECONDS,
			)
	except Exception:
		# Hooks must never raise.
		pass


def relative_last_seen(iso: str | None) -> str | None:
	"""Convenience: '5 minutes ago' / 'just now' / etc."""

	if not iso:
		return None
	try:
		from frappe.utils import get_datetime

		dt = get_datetime(iso)
		secs = max(0, int(time_diff_in_seconds(now_datetime(), dt)))
	except Exception:
		return None
	if secs < 30:
		return "just now"
	if secs < 90:
		return "1 minute ago"
	if secs < 3600:
		return f"{secs // 60} minutes ago"
	if secs < 7200:
		return "1 hour ago"
	if secs < 86400:
		return f"{secs // 3600} hours ago"
	if secs < 172800:
		return "yesterday"
	return f"{secs // 86400} days ago"
