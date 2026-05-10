"""Chat — booking conversations + helpline / support.

API surface (all methods accept the cookie session OR the
``Authorization: token <key>:<secret>`` header used by the mobile app):

  * ``list_threads`` — every thread the caller is a participant of
  * ``get_thread``  — metadata + the last N messages of one thread
  * ``send_message`` — append a message; broadcasts realtime
  * ``mark_read``   — clear the caller's unread counter
  * ``start_booking_chat(booking)`` — get-or-create a booking-scoped
    thread; idempotent on (booking)
  * ``start_support_chat()`` — get-or-create the caller's helpline
    thread; idempotent per user

Authorisation rule: a user may interact with a thread iff they are
its ``driver`` / ``passenger`` *or* hold a support role
(``Support Agent`` / ``Rideshare Admin`` / ``System Manager``).
"""

from __future__ import annotations

from typing import Any

import frappe
from frappe import _
from frappe.utils import now_datetime

SUPPORT_ROLES = {"Support Agent", "Rideshare Admin", "System Manager"}


# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------


def _user() -> str:
	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)
	return user


def _is_support(user: str) -> bool:
	return bool(set(frappe.get_roles(user)) & SUPPORT_ROLES)


def _authorize(thread_name: str, user: str | None = None) -> dict:
	user = user or _user()
	thread = frappe.db.get_value(
		"Chat Thread",
		thread_name,
		["name", "thread_type", "driver", "passenger", "status", "booking", "ride", "subject"],
		as_dict=True,
	)
	if not thread:
		frappe.throw(_("Chat not found."))
	if user in (thread.driver, thread.passenger) or _is_support(user):
		return thread
	frappe.throw(_("You don't have access to this chat."), frappe.PermissionError)


# ---------------------------------------------------------------------------
# Read APIs
# ---------------------------------------------------------------------------


@frappe.whitelist()
def list_threads(thread_type: str | None = None, limit: int = 50) -> list[dict]:
	"""Return chat threads visible to the caller.

	A regular user sees threads where they are the driver or passenger.
	Support staff see *all* support threads in addition to their own.
	"""

	user = _user()
	support = _is_support(user)
	conditions = ["1=1"]
	values: dict[str, Any] = {"u": user}

	if thread_type in ("Booking", "Support"):
		conditions.append("t.thread_type = %(thread_type)s")
		values["thread_type"] = thread_type

	if support:
		# Support users see: any thread they're in + all Support threads.
		conditions.append(
			"(t.driver = %(u)s OR t.passenger = %(u)s OR t.thread_type = 'Support')"
		)
	else:
		conditions.append("(t.driver = %(u)s OR t.passenger = %(u)s)")

	values["limit"] = int(limit)
	rows = frappe.db.sql(
		f"""SELECT t.name, t.thread_type, t.subject, t.status,
		           t.booking, t.ride,
		           t.driver, t.passenger,
		           t.last_message, t.last_message_at, t.last_sender,
		           t.unread_for_driver, t.unread_for_passenger, t.unread_for_support
		    FROM `tabChat Thread` t
		    WHERE {" AND ".join(conditions)}
		    ORDER BY COALESCE(t.last_message_at, t.creation) DESC
		    LIMIT %(limit)s""",
		values,
		as_dict=True,
	)

	# Attach a per-row `unread` count and a friendly counterparty display.
	for r in rows:
		r["unread"] = _unread_for(r, user, support)
		r["counterparty"] = _counterparty(r, user)
	return rows


def _unread_for(row: dict, user: str, support: bool) -> int:
	if support and user not in (row.get("driver"), row.get("passenger")):
		return int(row.get("unread_for_support") or 0)
	if user == row.get("driver"):
		return int(row.get("unread_for_driver") or 0)
	if user == row.get("passenger"):
		return int(row.get("unread_for_passenger") or 0)
	return 0


def _counterparty(row: dict, user: str) -> dict:
	"""Best-effort 'who am I talking to?' summary for the list view."""

	if row.get("thread_type") == "Support":
		if user == row.get("passenger"):
			return {"label": "Rideshare Support", "kind": "support"}
		return {
			"label": frappe.db.get_value("User", row.get("passenger"), "full_name") or "User",
			"kind": "user",
			"user": row.get("passenger"),
		}
	# Booking thread — flip the perspective.
	other_user = row.get("driver") if user == row.get("passenger") else row.get("passenger")
	if not other_user:
		return {"label": "—", "kind": "unknown"}
	return {
		"label": frappe.db.get_value("User", other_user, "full_name") or other_user,
		"kind": "driver" if other_user == row.get("driver") else "passenger",
		"user": other_user,
	}


@frappe.whitelist()
def get_thread(thread: str, limit: int = 50, before: str | None = None) -> dict:
	"""Return thread metadata + a window of messages.

	``before``: optional Chat Message ``name`` — when supplied, returns
	messages older than that one (cursor pagination for infinite scroll).
	"""

	user = _user()
	t = _authorize(thread, user)

	conds = ["thread = %(t)s"]
	values: dict[str, Any] = {"t": thread, "limit": int(limit)}
	if before:
		conds.append("name < %(before)s")
		values["before"] = before

	messages = frappe.db.sql(
		f"""SELECT name, sender, sender_role, body, sent_at, is_system, attachment
		    FROM `tabChat Message`
		    WHERE {" AND ".join(conds)}
		    ORDER BY sent_at DESC, name DESC
		    LIMIT %(limit)s""",
		values,
		as_dict=True,
	)
	# Hand back chronologically (oldest first) — the UI scrolls to bottom.
	messages.reverse()

	# Hydrate sender display data once.
	users = {m["sender"] for m in messages if m.get("sender")}
	user_meta = {
		u["name"]: u
		for u in frappe.db.get_all(
			"User",
			filters={"name": ["in", list(users)]} if users else {"name": "__noop__"},
			fields=["name", "full_name", "user_image"],
		)
	}
	for m in messages:
		meta = user_meta.get(m["sender"]) or {}
		m["sender_name"] = meta.get("full_name") or m["sender"]
		m["sender_image"] = meta.get("user_image")

	return {
		"thread": t,
		"messages": messages,
		"my_role": _my_role(t, user),
	}


def _my_role(t: dict, user: str) -> str:
	if user == t.get("driver"):
		return "Driver"
	if user == t.get("passenger"):
		return "Passenger"
	if _is_support(user):
		return "Support"
	return "Unknown"


# ---------------------------------------------------------------------------
# Write APIs
# ---------------------------------------------------------------------------


@frappe.whitelist()
def send_message(thread: str, body: str, attachment: str | None = None) -> dict:
	"""Append a message to ``thread`` and broadcast it to subscribers."""

	user = _user()
	body = (body or "").strip()
	if not body and not attachment:
		frappe.throw(_("Message body cannot be empty."), frappe.ValidationError)

	t = _authorize(thread, user)
	if t.status == "Closed":
		frappe.throw(_("This conversation is closed."))

	doc = frappe.new_doc("Chat Message")
	doc.thread = thread
	doc.sender = user
	doc.body = body[:5000]  # Long Text but cap to keep Redis payload sane
	if attachment:
		doc.attachment = attachment
	doc.flags.ignore_permissions = True
	doc.insert(ignore_permissions=True)
	frappe.db.commit()

	return {
		"name": doc.name,
		"thread": thread,
		"sender": doc.sender,
		"sender_role": doc.sender_role,
		"body": doc.body,
		"sent_at": doc.sent_at.isoformat() if doc.sent_at else None,
		"is_system": bool(doc.is_system),
	}


@frappe.whitelist()
def set_typing(thread: str, is_typing: int = 1) -> dict:
	"""Broadcast a typing indicator to the other side of the chat.

	The mobile/web client throttles its calls to one per ~2s while the user
	is actively typing.  We never persist this — it's a fire-and-forget
	realtime event delivered to the room subscribers.
	"""

	user = _user()
	t = _authorize(thread, user)

	# Don't echo to ourselves; we figure out who the *other* party is and,
	# when there's a known other user, target the publish to them only.
	other = None
	if user == t.get("driver"):
		other = t.get("passenger")
	elif user == t.get("passenger"):
		other = t.get("driver")

	payload = {
		"thread": thread,
		"sender": user,
		"sender_role": _my_role(t, user),
		"is_typing": bool(int(is_typing or 0)),
	}
	if other:
		# User-targeted send is delivered to every connected device of `other`.
		frappe.publish_realtime(
			event="rideshare:chat:typing",
			message=payload,
			user=other,
			after_commit=False,
		)
	else:
		# Fallback for support threads (no fixed other user): broadcast on
		# the per-thread room.
		frappe.publish_realtime(
			event="rideshare:chat:typing",
			message=payload,
			room=f"chat:{thread}",
			after_commit=False,
		)
	return {"ok": True}


@frappe.whitelist()
def mark_read(thread: str) -> dict:
	"""Clear the caller's unread counter on this thread."""

	user = _user()
	t = _authorize(thread, user)

	support = _is_support(user)
	updates: dict[str, int] = {}
	if user == t.get("driver"):
		updates["unread_for_driver"] = 0
	if user == t.get("passenger"):
		updates["unread_for_passenger"] = 0
	if support and user not in (t.get("driver"), t.get("passenger")):
		updates["unread_for_support"] = 0

	if updates:
		frappe.db.set_value("Chat Thread", thread, updates, update_modified=False)
		frappe.db.commit()
	return {"thread": thread, "cleared": list(updates.keys())}


# ---------------------------------------------------------------------------
# Get-or-create helpers
# ---------------------------------------------------------------------------


@frappe.whitelist()
def start_booking_chat(booking: str) -> dict:
	"""Open the conversation between the booker and the ride's driver.

	Idempotent: if a thread already exists for ``booking`` we return it.
	The caller must be a participant on that booking (driver or rider).
	"""

	user = _user()
	b = frappe.db.get_value(
		"Booking",
		booking,
		["name", "ride", "passenger", "status"],
		as_dict=True,
	)
	if not b:
		frappe.throw(_("Booking not found."))

	driver = frappe.db.get_value("Ride", b.ride, "driver")
	if not driver:
		frappe.throw(_("Ride has no driver."))
	if user not in (driver, b.passenger):
		frappe.throw(
			_("Only the driver and the passenger can chat on this booking."),
			frappe.PermissionError,
		)

	existing = frappe.db.get_value("Chat Thread", {"booking": b.name, "thread_type": "Booking"}, "name")
	if existing:
		return {"thread": existing, "created": False}

	ride = frappe.db.get_value(
		"Ride", b.ride, ["origin_city", "destination_city", "departure_datetime"], as_dict=True
	)
	subject = f"{ride.origin_city} → {ride.destination_city}"
	if ride.departure_datetime:
		try:
			from frappe.utils import get_datetime

			subject += f" · {get_datetime(ride.departure_datetime).strftime('%a %d %b, %H:%M')}"
		except Exception:
			pass

	thread = frappe.new_doc("Chat Thread")
	thread.thread_type = "Booking"
	thread.subject = subject
	thread.booking = b.name
	thread.ride = b.ride
	thread.driver = driver
	thread.passenger = b.passenger
	thread.status = "Open"
	thread.flags.ignore_permissions = True
	thread.insert(ignore_permissions=True)

	# Seed with a system welcome line so the thread isn't empty.
	_post_system(
		thread.name,
		f"Booking confirmed for {subject}. Coordinate pickup details here.",
	)
	frappe.db.commit()
	return {"thread": thread.name, "created": True}


@frappe.whitelist()
def start_support_chat(message: str | None = None) -> dict:
	"""Get-or-create the caller's helpline thread.

	A user has at most one open support thread at a time.  ``message``
	is optional first-message content (handy for "I have a problem with
	booking BB-…" deep-links).
	"""

	user = _user()

	existing = frappe.db.get_value(
		"Chat Thread",
		{"thread_type": "Support", "passenger": user, "status": "Open"},
		"name",
	)
	if existing:
		thread_name = existing
		created = False
	else:
		thread = frappe.new_doc("Chat Thread")
		thread.thread_type = "Support"
		thread.subject = "Helpline"
		thread.passenger = user
		thread.status = "Open"
		thread.flags.ignore_permissions = True
		thread.insert(ignore_permissions=True)
		_post_system(
			thread.name,
			"Hi! Tell us what's going on and the team will reply shortly. "
			"Average response time is under 30 minutes during 9–9 IST.",
		)
		thread_name = thread.name
		created = True

	if message:
		send_message(thread_name, message)

	frappe.db.commit()
	return {"thread": thread_name, "created": created}


@frappe.whitelist()
def close_thread(thread: str) -> dict:
	user = _user()
	t = _authorize(thread, user)
	# Only the support side or the original passenger may close.
	if not (_is_support(user) or user == t.get("passenger")):
		frappe.throw(_("Only the requester or support can close a chat."), frappe.PermissionError)
	frappe.db.set_value("Chat Thread", thread, "status", "Closed")
	_post_system(thread, "Conversation closed.")
	frappe.db.commit()
	return {"thread": thread, "status": "Closed"}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _post_system(thread: str, body: str) -> str:
	doc = frappe.new_doc("Chat Message")
	doc.thread = thread
	doc.sender = "Administrator"
	doc.sender_role = "System"
	doc.is_system = 1
	doc.body = body
	doc.sent_at = now_datetime()
	doc.flags.ignore_permissions = True
	doc.insert(ignore_permissions=True)
	return doc.name
