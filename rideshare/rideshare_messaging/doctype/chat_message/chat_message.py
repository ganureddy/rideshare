"""Chat Message controller.

After insert we:
  1. Stamp the parent thread's ``last_message`` / ``last_message_at`` /
     ``last_sender`` so list views can render a preview without joining.
  2. Bump the unread counter for everyone *except* the sender.
  3. Broadcast a realtime payload on the ``chat:<thread_name>`` room so
     subscribed clients receive the message instantly.

We deliberately keep all of this in ``after_insert`` (not ``on_update``)
because chat messages are append-only: editing or re-saving an existing
record must NOT re-broadcast or re-bump counters.
"""

from __future__ import annotations

import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime


class ChatMessage(Document):
	def before_insert(self) -> None:
		if not self.sent_at:
			self.sent_at = now_datetime()
		if not self.sender:
			self.sender = frappe.session.user
		# Default lifecycle on a fresh message is "sent".  The sender's
		# own pane treats a sent message as ✓; the recipient's first
		# fetch / mark_delivered call promotes it to "delivered" (✓✓);
		# their explicit mark-read promotes to "read" (✓✓ blue).
		if not self.delivery_status:
			self.delivery_status = "sent"
		if not self.message_type:
			self.message_type = "system" if self.is_system else "text"
		# Always derive sender_role from the thread (don't trust client input)
		# unless the caller explicitly marked this as a System message.
		if self.sender_role == "System" and self.is_system:
			return
		if self.thread:
			thread = frappe.db.get_value(
				"Chat Thread", self.thread, ["driver", "passenger"], as_dict=True
			)
			if thread:
				if thread.driver and thread.driver == self.sender:
					self.sender_role = "Driver"
				elif thread.passenger and thread.passenger == self.sender:
					self.sender_role = "Passenger"
				elif _has_support_role(self.sender):
					self.sender_role = "Support"
				else:
					self.sender_role = "Passenger"

	def after_insert(self) -> None:
		self._touch_thread()
		self._broadcast()

	def _touch_thread(self) -> None:
		thread = frappe.get_doc("Chat Thread", self.thread)
		preview = (self.body or "").replace("\n", " ").strip()
		if len(preview) > 200:
			preview = preview[:197] + "…"
		thread.last_message = preview
		thread.last_message_at = self.sent_at
		thread.last_sender = self.sender

		# Bump unread counters for everyone *but* the sender.
		if not self.is_system:
			if self.sender_role != "Driver" and thread.driver:
				thread.unread_for_driver = (thread.unread_for_driver or 0) + 1
			if self.sender_role != "Passenger" and thread.passenger:
				thread.unread_for_passenger = (thread.unread_for_passenger or 0) + 1
			if self.sender_role != "Support":
				thread.unread_for_support = (thread.unread_for_support or 0) + 1

		thread.flags.ignore_permissions = True
		thread.save(ignore_permissions=True)

	def _broadcast(self) -> None:
		"""Push the new message onto the realtime room for this thread.

		The payload mirrors what `get_thread` returns so the client can
		`appendMessage(payload)` directly without a re-fetch.  Includes:

		  * ``sender_name`` — User.full_name, so bubbles label the real
		    person rather than falling back to a generic role label.
		  * ``message_type`` + ``attachment`` + ``attachment_meta`` — the
		    client uses these to switch between text / image / audio /
		    file bubble rendering.
		  * ``delivery_status`` — starts as "sent"; updated later via
		    rideshare:chat:status events as the recipient receives /
		    reads the message.
		"""

		sender_name = (
			frappe.db.get_value("User", self.sender, "full_name") or self.sender
		)
		payload = {
			"name": self.name,
			"thread": self.thread,
			"sender": self.sender,
			"sender_name": sender_name,
			"sender_role": self.sender_role,
			"body": self.body,
			"sent_at": self.sent_at.isoformat() if self.sent_at else None,
			"is_system": bool(self.is_system),
			"message_type": self.message_type or "text",
			"attachment": self.attachment,
			"attachment_meta": self.attachment_meta,
			"delivery_status": self.delivery_status or "sent",
		}
		frappe.publish_realtime(
			event="rideshare:chat:message",
			message=payload,
			room=f"chat:{self.thread}",
			after_commit=True,
		)
		self._push_notification()

	def _push_notification(self) -> None:
		"""Send a WhatsApp-style push to the recipient(s) of the message.

		System messages aren't worth interrupting the user for, and we
		never push the sender their own echo.
		"""

		if self.is_system:
			return

		try:
			from rideshare.utils.push import notify_user
		except Exception:
			return

		thread = frappe.db.get_value(
			"Chat Thread",
			self.thread,
			["driver", "passenger", "thread_type", "subject", "ride", "booking"],
			as_dict=True,
		)
		if not thread:
			return

		# Sender display name for the notification title.
		sender_name = (
			frappe.db.get_value("User", self.sender, "full_name") or self.sender
		)

		# Truncate body to keep the notification compact.
		preview = (self.body or "").strip().replace("\n", " ")
		if len(preview) > 140:
			preview = preview[:137] + "…"

		recipients: set[str] = set()
		if thread.driver and thread.driver != self.sender:
			recipients.add(thread.driver)
		if thread.passenger and thread.passenger != self.sender:
			recipients.add(thread.passenger)

		data = {
			"type": "chat",
			"thread": self.thread,
			"booking": thread.get("booking"),
			"ride": thread.get("ride"),
			"sender": self.sender,
		}

		for u in recipients:
			notify_user(
				u,
				title=sender_name,
				body=preview or "📎 Attachment",
				data=data,
				channel="chat",
			)


def _has_support_role(user: str) -> bool:
	roles = set(frappe.get_roles(user))
	return bool(roles & {"Support Agent", "Rideshare Admin", "System Manager"})
