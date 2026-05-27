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

	Side effects:
	  * Any message in the returned window addressed to the *caller*
	    that's still flagged "sent" gets promoted to "delivered" and
	    a ``rideshare:chat:status`` event fires so the *sender's* UI
	    can flip ✓ → ✓✓.
	  * The caller's per-thread unread counter is **not** cleared
	    here — that's a separate, explicit ``mark_read`` call that
	    fires when the thread actually becomes visible on screen.
	"""

	user = _user()
	t = _authorize(thread, user)

	conds = ["thread = %(t)s"]
	values: dict[str, Any] = {"t": thread, "limit": int(limit)}
	if before:
		conds.append("name < %(before)s")
		values["before"] = before

	messages = frappe.db.sql(
		f"""SELECT name, sender, sender_role, body, sent_at, is_system,
		           message_type, attachment, attachment_meta,
		           delivery_status, delivered_at, read_at
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
		# attachment_meta arrives as a JSON string; normalise to dict.
		if m.get("attachment_meta") and isinstance(m["attachment_meta"], str):
			try:
				m["attachment_meta"] = frappe.parse_json(m["attachment_meta"])
			except Exception:
				m["attachment_meta"] = None

	# Promote in-window messages addressed to the caller from sent →
	# delivered.  Cheap (one bulk UPDATE) and lets the sender's ✓ ✓✓
	# ticks update automatically the moment the recipient opens the
	# screen.
	_promote_to_delivered(thread, user, [m["name"] for m in messages])

	return {
		"thread": t,
		"messages": messages,
		"my_role": _my_role(t, user),
	}


def _promote_to_delivered(thread: str, viewer: str, message_names: list[str]) -> None:
	"""Mark messages NOT sent by ``viewer`` as ``delivered`` (idempotent).

	Broadcasts one ``rideshare:chat:status`` event with the affected
	message ids so the sender's pane can flip the ticks live.
	"""

	if not message_names:
		return
	rows = frappe.db.sql(
		"""SELECT name FROM `tabChat Message`
		   WHERE thread = %(t)s
		     AND name IN %(ids)s
		     AND sender != %(u)s
		     AND COALESCE(delivery_status, 'sent') = 'sent'""",
		{"t": thread, "ids": tuple(message_names), "u": viewer},
		as_dict=True,
	)
	if not rows:
		return
	ids = [r["name"] for r in rows]
	frappe.db.sql(
		"""UPDATE `tabChat Message`
		   SET delivery_status = 'delivered',
		       delivered_at = %(now)s
		   WHERE name IN %(ids)s""",
		{"now": now_datetime(), "ids": tuple(ids)},
	)
	frappe.db.commit()
	frappe.publish_realtime(
		event="rideshare:chat:status",
		message={
			"thread": thread,
			"status": "delivered",
			"messages": ids,
			"by": viewer,
			"at": now_datetime().isoformat(),
		},
		room=f"chat:{thread}",
		after_commit=False,
	)


@frappe.whitelist()
def mark_delivered(thread: str, message_ids: str | list[str] | None = None) -> dict:
	"""Explicit "I have these messages on my device" ack.

	Used by the mobile chat screen on socket reconnect — the WebView
	or React Native app calls this with the ids of messages it has in
	memory but hasn't yet acked.  Server-side it's the same path as
	``get_thread``: bulk-promote any "sent" → "delivered" and broadcast
	the change so the sender sees ✓✓.
	"""

	user = _user()
	t = _authorize(thread, user)
	# Defensive: ignore inputs that aren't strings.  Callers can pass
	# either a JSON list or a comma-separated string.
	if isinstance(message_ids, str):
		try:
			parsed = frappe.parse_json(message_ids)
			ids = parsed if isinstance(parsed, list) else [s.strip() for s in message_ids.split(",")]
		except Exception:
			ids = [s.strip() for s in message_ids.split(",")]
	else:
		ids = list(message_ids or [])
	ids = [i for i in ids if isinstance(i, str) and i]
	if not ids:
		return {"ok": True, "thread": t["name"], "promoted": 0}
	before = len(ids)
	_promote_to_delivered(t["name"], user, ids)
	return {"ok": True, "thread": t["name"], "promoted": before}


@frappe.whitelist()
def mark_message_read(thread: str, up_to: str | None = None) -> dict:
	"""Mark every message in the thread that the caller has *not yet*
	read as ``read`` (✓✓ blue), up to and including ``up_to``.

	When ``up_to`` is omitted, every unread message in the thread is
	flipped — that's the "I just opened the conversation" case.

	Also clears the caller's per-side unread counter on the thread
	(same effect ``mark_read`` had previously) and broadcasts a single
	``rideshare:chat:status`` event so the sender's UI sees ✓✓ blue.
	"""

	user = _user()
	t = _authorize(thread, user)

	# Build the WHERE: messages on this thread, sent by SOMEONE ELSE,
	# whose lifecycle hasn't already reached "read", optionally bounded
	# by sent_at <= up_to's sent_at.
	conds = [
		"thread = %(t)s",
		"sender != %(u)s",
		"COALESCE(delivery_status, 'sent') != 'read'",
	]
	values: dict[str, Any] = {"t": thread, "u": user, "now": now_datetime()}
	if up_to:
		ts = frappe.db.get_value("Chat Message", up_to, "sent_at")
		if ts:
			conds.append("sent_at <= %(ts)s")
			values["ts"] = ts

	rows = frappe.db.sql(
		f"""SELECT name FROM `tabChat Message`
		    WHERE {" AND ".join(conds)}""",
		values,
		as_dict=True,
	)
	ids = [r["name"] for r in rows]
	if ids:
		frappe.db.sql(
			"""UPDATE `tabChat Message`
			   SET delivery_status = 'read',
			       delivered_at = COALESCE(delivered_at, %(now)s),
			       read_at = %(now)s
			   WHERE name IN %(ids)s""",
			{"now": values["now"], "ids": tuple(ids)},
		)

	# Fold the caller's per-side unread counter to zero — same effect
	# as the legacy ``mark_read`` API.
	updates: dict[str, int] = {}
	if user == t.get("driver"):
		updates["unread_for_driver"] = 0
	if user == t.get("passenger"):
		updates["unread_for_passenger"] = 0
	if _is_support(user) and user not in (t.get("driver"), t.get("passenger")):
		updates["unread_for_support"] = 0
	if updates:
		frappe.db.set_value("Chat Thread", thread, updates, update_modified=False)

	frappe.db.commit()

	if ids:
		frappe.publish_realtime(
			event="rideshare:chat:status",
			message={
				"thread": thread,
				"status": "read",
				"messages": ids,
				"by": user,
				"at": values["now"].isoformat(),
			},
			room=f"chat:{thread}",
			after_commit=False,
		)
	return {"ok": True, "thread": thread, "promoted": len(ids)}


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
def send_message(
	thread: str,
	body: str,
	attachment: str | None = None,
	message_type: str | None = None,
	attachment_meta: str | dict | None = None,
) -> dict:
	"""Append a message to ``thread`` and broadcast it to subscribers.

	``message_type``: one of ``text``, ``image``, ``audio``, ``file``,
	``location`` — drives bubble rendering on the client.  When
	omitted we infer ``text`` (or ``image``/``file`` from the
	attachment URL extension as a friendly default).

	``attachment_meta``: optional JSON metadata for non-text payloads:

	  * image    — ``{"width": 800, "height": 600, "mime": "image/jpeg"}``
	  * audio    — ``{"duration_seconds": 7.4, "mime": "audio/m4a"}``
	  * file     — ``{"filename": "boarding.pdf", "mime": "application/pdf",
	                  "size": 12489}``
	  * location — ``{"lat": 12.97, "lng": 77.59, "label": "Cubbon Park"}``
	"""

	user = _user()
	body = (body or "").strip()
	if not body and not attachment:
		frappe.throw(_("Message body cannot be empty."), frappe.ValidationError)

	t = _authorize(thread, user)
	if t.status == "Closed":
		frappe.throw(_("This conversation is closed."))

	# Default the message type intelligently when the caller didn't
	# bother to set one — most clients (the mobile app definitely)
	# always pass a text message without it.
	resolved_type = (message_type or "").strip().lower()
	if resolved_type not in ("text", "image", "audio", "file", "location", "system"):
		if attachment:
			ext = (attachment.rsplit(".", 1)[-1] or "").lower()
			if ext in ("jpg", "jpeg", "png", "webp", "heic", "gif"):
				resolved_type = "image"
			elif ext in ("m4a", "mp3", "aac", "wav", "ogg", "opus"):
				resolved_type = "audio"
			else:
				resolved_type = "file"
		else:
			resolved_type = "text"

	# Normalise attachment_meta to a JSON-encoded string so the field
	# accepts both a dict (preferred) and a string (RN form-encoded).
	meta_payload: str | None = None
	if attachment_meta:
		try:
			parsed = (
				attachment_meta
				if isinstance(attachment_meta, (dict, list))
				else frappe.parse_json(attachment_meta)
			)
			if parsed is not None:
				meta_payload = frappe.as_json(parsed)
		except Exception:
			meta_payload = None

	doc = frappe.new_doc("Chat Message")
	doc.thread = thread
	doc.sender = user
	doc.body = body[:5000]  # Long Text but cap to keep Redis payload sane
	doc.message_type = resolved_type
	if attachment:
		doc.attachment = attachment
	if meta_payload:
		doc.attachment_meta = meta_payload
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
		"message_type": doc.message_type,
		"attachment": doc.attachment,
		"attachment_meta": doc.attachment_meta,
		"delivery_status": doc.delivery_status or "sent",
	}


# ---------------------------------------------------------------------------
# WebView session bootstrap — issues a one-shot code the Jinja chat page
# trades for a real cookie session.  Lets the mobile WebView load the
# page without putting api_key/secret in the URL or in browser history.
# ---------------------------------------------------------------------------

_CHAT_EXCHANGE_NS = "rideshare:chat:exchange"
_CHAT_EXCHANGE_TTL = 60   # seconds — the WebView hits the URL within ms


@frappe.whitelist()
def issue_chat_session_code(thread: str) -> dict:
	"""Mint a one-shot code that the chat WebView trades for a session.

	The code is bound to (current_user, thread) for 60 seconds and is
	single-use: the redeem path deletes it after the first hit.
	"""

	import secrets

	user = _user()
	# Re-use the same authorisation rule as get_thread.
	_authorize(thread, user)
	code = secrets.token_hex(32)
	frappe.cache().set_value(
		f"{_CHAT_EXCHANGE_NS}:{code}",
		frappe.as_json({"user": user, "thread": thread}),
		expires_in_sec=_CHAT_EXCHANGE_TTL,
	)
	return {"code": code, "ttl_seconds": _CHAT_EXCHANGE_TTL}


def consume_chat_session_code(code: str) -> dict | None:
	"""Internal: redeem a chat session code; returns the bound payload.

	Called by the Jinja chat page (server-side) — never whitelisted, so
	the only way to redeem is through that page which we control.
	Returns ``None`` when the code is missing / expired / malformed.
	"""

	if not code or not isinstance(code, str) or len(code) > 128:
		return None
	cache = frappe.cache()
	key = f"{_CHAT_EXCHANGE_NS}:{code}"
	raw = cache.get_value(key)
	if not raw:
		return None
	try:
		cache.delete_value(key)
	except Exception:
		pass
	try:
		data = frappe.parse_json(raw)
	except Exception:
		return None
	if not (data.get("user") and data.get("thread")):
		return None
	return data


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

	**Active-ride scope**: chat is only allowed once a booking has been
	confirmed and before the trip is closed out.  This matches the
	user's spec — driver and rider can talk between "ride accepted"
	and "ride completed".  Pending bookings still create the thread
	(so the driver-side review screen has a way to message the rider
	before confirming) but riders see a "waiting for confirmation"
	stub on their side.

	Allowed booking statuses: ``Pending``, ``Confirmed``, ``InProgress``.
	Blocked: ``Cancelled``, ``Completed`` — the chat for those rides
	stays read-only via ``send_message``'s ``status == "Closed"`` check
	(see also: close_thread when a ride completes).
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
	if b.status in ("Cancelled",):
		frappe.throw(_("This booking was cancelled — no chat available."))

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
