"""Expo push notifications.

We never embed the FCM / APNS keys in the mobile bundle.  Devices register
their Expo push token (``ExponentPushToken[xxx...]``) with our backend at
login time; the backend posts JSON batches to Expo's public endpoint
``https://exp.host/--/api/v2/push/send`` which fans out to FCM / APNS on
our behalf.  No Expo account secret is required for unauthenticated push
sends — only a valid token.

Usage::

    from rideshare.utils.push import notify_user

    notify_user(
        user="123@rideshare.local",
        title="New booking request",
        body="Asha would like to book 1 seat on your Delhi → Jaipur ride.",
        data={"type": "booking", "booking": "BB-AB12CD", "ride": "RIDE-2026-0001"},
    )

The send is automatically backgrounded through ``frappe.enqueue`` — call
sites never block on the upstream POST.

DeviceNotRegistered errors flip the matching token row to ``is_active=0``
so we stop trying to reach a uninstalled / signed-out device.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Iterable

import frappe
import requests
from frappe.utils import now_datetime

logger = logging.getLogger(__name__)

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
EXPO_TIMEOUT = 8  # seconds — Expo p99 is well under this
# Expo accepts up to 100 messages per call.  Keep batches small so a
# single transient failure only retries a slice of recipients.
BATCH = 90


def notify_user(
	user: str,
	*,
	title: str,
	body: str,
	data: dict[str, Any] | None = None,
	channel: str = "default",
	sound: str | None = "default",
	priority: str = "high",
) -> None:
	"""Queue a push to every active device the user is signed in on.

	Returns immediately — the actual HTTP POST runs in a background job so
	hot paths (chat insert, booking confirm) don't pay for it.
	"""

	if not user or user == "Guest" or user == "Administrator":
		return

	payload = {
		"title": title,
		"body": body,
		"data": data or {},
		"channelId": channel,
		"sound": sound,
		"priority": priority,
		"_user": user,
	}
	# Always background so the caller is never blocked on Expo's HTTP
	# round-trip (their p99 is ~1.5s but we don't want to risk it on the
	# request thread).
	frappe.enqueue(
		"rideshare.utils.push._dispatch_to_user",
		queue="short",
		now=False,
		**payload,
	)


def notify_users(
	users: Iterable[str],
	*,
	title: str,
	body: str,
	data: dict[str, Any] | None = None,
	channel: str = "default",
) -> None:
	"""Queue a push to multiple users — one Expo batch per user."""

	for u in {u for u in users if u and u not in ("Guest", "Administrator")}:
		notify_user(u, title=title, body=body, data=data, channel=channel)


# ---------------------------------------------------------------------------
# Background worker — reads tokens, posts to Expo, retires dead ones.
# ---------------------------------------------------------------------------


def _dispatch_to_user(
	*,
	title: str,
	body: str,
	data: dict[str, Any],
	channelId: str,  # noqa: N803 — matches Expo field
	sound: str | None,
	priority: str,
	_user: str,
) -> None:
	"""Background-job entrypoint; do not call directly."""

	tokens = frappe.get_all(
		"User Push Token",
		filters={"user": _user, "is_active": 1},
		fields=["name", "token", "platform"],
	)
	if not tokens:
		logger.debug("rideshare.push: no active tokens for user=%s", _user)
		return

	messages: list[dict[str, Any]] = []
	for t in tokens:
		messages.append(
			{
				"to": t["token"],
				"title": title,
				"body": body,
				"sound": sound,
				"priority": priority,
				"channelId": channelId,
				"data": data,
			}
		)

	for chunk_start in range(0, len(messages), BATCH):
		chunk = messages[chunk_start : chunk_start + BATCH]
		_send_batch(chunk, tokens)


def _send_batch(chunk: list[dict[str, Any]], tokens: list[dict]) -> None:
	"""POST one batch to Expo and reconcile the per-message receipts.

	Tokens for which Expo returns ``DeviceNotRegistered`` (or any status
	== "error") are marked inactive so we stop hammering them.  Other
	transient errors are simply logged — Expo recommends retry-on-receipt,
	which we omit at the MVP because chat / booking pushes are short-TTL.
	"""

	try:
		resp = requests.post(
			EXPO_PUSH_URL,
			data=json.dumps(chunk),
			headers={
				"Accept": "application/json",
				"Accept-encoding": "gzip, deflate",
				"Content-Type": "application/json",
			},
			timeout=EXPO_TIMEOUT,
		)
	except requests.RequestException as exc:
		logger.warning("rideshare.push: Expo unreachable: %s", exc)
		return

	if resp.status_code >= 400:
		logger.warning(
			"rideshare.push: Expo HTTP %s body=%s", resp.status_code, resp.text[:500]
		)
		return

	body = {}
	try:
		body = resp.json()
	except ValueError:
		logger.warning("rideshare.push: non-JSON response from Expo")
		return

	receipts = body.get("data") or []
	if not isinstance(receipts, list):
		# Expo returns dict-on-error for malformed batches.
		logger.warning("rideshare.push: unexpected receipt shape=%s", body)
		return

	# Mark unreachable tokens inactive.  Receipts are 1:1 with `chunk`.
	for i, receipt in enumerate(receipts):
		if not isinstance(receipt, dict):
			continue
		if receipt.get("status") == "ok":
			continue
		details = receipt.get("details") or {}
		err = details.get("error") or receipt.get("message") or "unknown"
		token = chunk[i].get("to")
		row = next((t for t in tokens if t["token"] == token), None)
		logger.info(
			"rideshare.push: receipt err=%s token=%s row=%s", err, (token or "")[:24], row,
		)
		if err in ("DeviceNotRegistered", "InvalidCredentials") and row:
			try:
				frappe.db.set_value(
					"User Push Token", row["name"], "is_active", 0, update_modified=False
				)
				frappe.db.commit()
			except Exception:  # noqa: BLE001
				logger.exception("rideshare.push: could not retire dead token")


# ---------------------------------------------------------------------------
# Token CRUD — used by the API in rideshare/api/push.py.
# ---------------------------------------------------------------------------


def upsert_token(user: str, token: str, platform: str = "android", app_version: str | None = None) -> str:
	"""Upsert a (user, token) pair.  Returns the persisted record name."""

	existing = frappe.db.get_value("User Push Token", {"token": token}, "name")
	if existing:
		updates: dict[str, Any] = {
			"user": user,
			"is_active": 1,
			"last_seen_at": now_datetime(),
		}
		if platform:
			updates["platform"] = platform
		if app_version:
			updates["app_version"] = app_version
		frappe.db.set_value("User Push Token", existing, updates, update_modified=False)
		frappe.db.commit()
		return existing

	doc = frappe.new_doc("User Push Token")
	doc.user = user
	doc.token = token
	doc.platform = platform or "android"
	if app_version:
		doc.app_version = app_version
	doc.is_active = 1
	doc.last_seen_at = now_datetime()
	doc.flags.ignore_permissions = True
	doc.insert(ignore_permissions=True)
	frappe.db.commit()
	return doc.name


def remove_token(token: str) -> bool:
	"""Drop a token (called on logout / app uninstall hint)."""

	name = frappe.db.get_value("User Push Token", {"token": token}, "name")
	if not name:
		return False
	frappe.db.delete("User Push Token", {"name": name})
	frappe.db.commit()
	return True
